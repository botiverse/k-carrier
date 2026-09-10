/- Lean 4 model of K's two-slot upgrade transaction.

Projection of the TypeScript engine:
  * `Phase` mirrors core/src/txn/state.ts::TxnPhase, all seven phases.
  * Intent steps mirror core/src/txn/transitions.ts::TRANSITIONS, including
    the rollback edges from every in-flight phase.
  * Effect steps mirror the host/slot calls the engine issues after each
    journaled intent (core/src/txn/engine.ts), one step per call, so a crash
    can fall between any two of them.
  * Crash and recovery: a crash loses nothing durable. Recovery only ever
    (a) journals a rollback intent from an in-flight phase, or (b) replays the
    effects of the last durable intent. Both are ordinary steps of the
    relation, so every crash-matrix instant (before-journal, after-journal,
    after-action; see harness/src/crash/enumerate.ts) is a reachable state and
    the theorems below hold there.

Proved for every reachable machine (`protocol_guarantees`):
  * never_dual_run : a stable incarnation and an experiment incarnation are
                     never live at once. This rests on every path that starts
                     a process (handover, rollback, recovery replay) being
                     guarded by the stop it follows; remove a guard and the
                     proof fails.
  * never_bricked  : the stable slot always holds usable bytes. No step clears
                     it; promote replaces it with the verified candidate.
  * write_ahead    : an experiment process is live only after a durable
                     handing-over intent, and experiment bytes exist only after
                     a durable staged intent.

Assumptions, shared with the HostAdapter contract (assume-guarantee): stop()
returning means the process is gone; start() starts only the requested slot;
the probe answers for one live incarnation. The model does not resolve the
filesystem window inside promote (rename aside, rename over), which is below
one effect step; in code the durable promote intent plus idempotent replay
covers it.

Non-vacuity: the `example`s at the end exhibit reachable states with a live
experiment, a completed promotion and a completed rollback, so the guards do
not make the interesting states unreachable.

Toolchain note: declare proofs with `theorem`, not `lemma`; `lemma` after a
multi-clause `def`/`inductive` trips a parser quirk on some releases.
-/

inductive Phase where
  | idle | staged | handingOver | runningExperiment | readback | promoted | rolledBack
deriving DecidableEq, Repr

structure Machine where
  phase : Phase
  stableOk : Bool     -- stable slot holds usable bytes
  hasExp : Bool       -- experiment slot is populated
  liveStable : Bool   -- an incarnation started from the stable slot is running
  liveExp : Bool      -- an incarnation started from the experiment slot is running
  journal : List Phase
deriving Repr

def init : Machine :=
  { phase := .idle, stableOk := true, hasExp := false, liveStable := true, liveExp := false, journal := [] }

def Phase.inFlight : Phase → Bool
  | .staged | .handingOver | .runningExperiment | .readback => true
  | _ => false

def Phase.atRest : Phase → Bool
  | .idle | .promoted | .rolledBack => true
  | _ => false

/-- Journal an intent. The phase changes only through the journal. -/
def Machine.intent (m : Machine) (p : Phase) : Machine :=
  { m with phase := p, journal := m.journal ++ [p] }

inductive Step : Machine → Machine → Prop
  -- idle/terminal → staged: verified bytes go into the experiment slot
  | stage (m) (h : m.phase.atRest = true) (hx : m.hasExp = false) : Step m (m.intent .staged)
  | stageEffect (m) (h : m.phase = .staged) : Step m { m with hasExp := true }
  -- staged → handing-over: quiesce, stop stable, start experiment
  | handover (m) (h : m.phase = .staged) (hx : m.hasExp = true) : Step m (m.intent .handingOver)
  | stopStable (m) (h : m.phase = .handingOver) : Step m { m with liveStable := false }
  | startExp (m) (h : m.phase = .handingOver) (hs : m.liveStable = false) : Step m { m with liveExp := true }
  -- handing-over → running-experiment → readback: probe, evaluate predicates
  | probe (m) (h : m.phase = .handingOver) : Step m (m.intent .runningExperiment)
  | evaluate (m) (h : m.phase = .runningExperiment) : Step m (m.intent .readback)
  -- readback → promoted: a live candidate passed; experiment becomes stable
  | promote (m) (h : m.phase = .readback) (hl : m.liveExp = true) : Step m (m.intent .promoted)
  | promoteEffect (m) (h : m.phase = .promoted) :
      Step m { m with stableOk := true, hasExp := false,
                      liveStable := m.liveStable || m.liveExp, liveExp := false }
  -- rollback intent from any in-flight phase: the engine's refusal paths and
  -- recovery before durable promote intent both land here
  | rollback (m) (h : m.phase.inFlight = true) : Step m (m.intent .rolledBack)
  | stopExp (m) (h : m.phase = .rolledBack) : Step m { m with liveExp := false }
  | startStable (m) (h : m.phase = .rolledBack) (hs : m.liveExp = false) : Step m { m with liveStable := true }
  | clearExp (m) (h : m.phase = .rolledBack) (hs : m.liveStable = true) : Step m { m with hasExp := false }

inductive Reachable : Machine → Prop
  | init : Reachable init
  | step {m m' : Machine} (hm : Reachable m) (hs : Step m m') : Reachable m'

/-- The inductive invariant. Conjuncts 1-3 are the headline guarantees; 4 and 5
are the write-ahead facts they rest on. -/
def Safe (m : Machine) : Prop :=
  m.stableOk = true
  ∧ (m.liveStable && m.liveExp) = false
  ∧ (m.phase = .idle ∨ m.phase ∈ m.journal)
  ∧ (m.liveExp = true → Phase.handingOver ∈ m.journal)
  ∧ (m.hasExp = true → Phase.staged ∈ m.journal)

theorem init_inv : Safe init := by
  simp [Safe, init]

theorem step_preserves (m m' : Machine) (hs : Step m m') (hi : Safe m) : Safe m' := by
  cases hs <;> simp_all [Safe, Machine.intent, List.mem_append]

theorem reachable_inv (m : Machine) (h : Reachable m) : Safe m := by
  induction h with
  | init => exact init_inv
  | step _ hs ih => exact step_preserves _ _ hs ih

theorem never_bricked (m : Machine) (h : Reachable m) : m.stableOk = true :=
  (reachable_inv m h).1

theorem never_dual_run (m : Machine) (h : Reachable m) : (m.liveStable && m.liveExp) = false :=
  (reachable_inv m h).2.1

theorem write_ahead (m : Machine) (h : Reachable m) :
    (m.liveExp = true → Phase.handingOver ∈ m.journal) ∧ (m.hasExp = true → Phase.staged ∈ m.journal) :=
  ⟨(reachable_inv m h).2.2.2.1, (reachable_inv m h).2.2.2.2⟩

theorem protocol_guarantees (m : Machine) (h : Reachable m) :
    m.stableOk = true
    ∧ (m.liveStable && m.liveExp) = false
    ∧ (m.liveExp = true → Phase.handingOver ∈ m.journal)
    ∧ (m.hasExp = true → Phase.staged ∈ m.journal) :=
  ⟨never_bricked m h, never_dual_run m h, (write_ahead m h).1, (write_ahead m h).2⟩

-- ===========================================================================
-- Non-vacuity: the guards leave the interesting states reachable.
-- ===========================================================================

/-- Happy path up to a live experiment (crash here = handing-over@after-action). -/
def liveExperiment : Machine :=
  { phase := .handingOver, stableOk := true, hasExp := true, liveStable := false, liveExp := true,
    journal := [.staged, .handingOver] }

example : Reachable liveExperiment :=
  Reachable.step (Reachable.step (Reachable.step (Reachable.step (Reachable.step Reachable.init
    (Step.stage init (by decide) rfl))
    (Step.stageEffect _ rfl))
    (Step.handover _ rfl rfl))
    (Step.stopStable _ rfl))
    (Step.startExp _ rfl rfl)

/-- Promote intent durable but its effect not yet applied (promoted@after-journal). -/
def promoteIntentOnly : Machine :=
  { phase := .promoted, stableOk := true, hasExp := true, liveStable := false, liveExp := true,
    journal := [.staged, .handingOver, .runningExperiment, .readback, .promoted] }

theorem reach_promoteIntentOnly : Reachable promoteIntentOnly :=
  Reachable.step (Reachable.step (Reachable.step (Reachable.step (Reachable.step (Reachable.step
    (Reachable.step (Reachable.step Reachable.init
    (Step.stage init (by decide) rfl))
    (Step.stageEffect _ rfl))
    (Step.handover _ rfl rfl))
    (Step.stopStable _ rfl))
    (Step.startExp _ rfl rfl))
    (Step.probe _ rfl))
    (Step.evaluate _ rfl))
    (Step.promote _ rfl rfl)

/-- Promotion completed: the candidate is now the stable incarnation. -/
example : Reachable
    { phase := .promoted, stableOk := true, hasExp := false, liveStable := true, liveExp := false,
      journal := [.staged, .handingOver, .runningExperiment, .readback, .promoted] } :=
  Reachable.step reach_promoteIntentOnly (Step.promoteEffect _ rfl)

/-- Rollback after a live experiment: stop it, restore stable, clear the slot. -/
example : Reachable
    { phase := .rolledBack, stableOk := true, hasExp := false, liveStable := true, liveExp := false,
      journal := [.staged, .handingOver, .rolledBack] } :=
  Reachable.step (Reachable.step (Reachable.step (Reachable.step (Reachable.step (Reachable.step
    (Reachable.step (Reachable.step (Reachable.step Reachable.init
    (Step.stage init (by decide) rfl))
    (Step.stageEffect _ rfl))
    (Step.handover _ rfl rfl))
    (Step.stopStable _ rfl))
    (Step.startExp _ rfl rfl))
    (Step.rollback _ (by decide)))
    (Step.stopExp _ rfl))
    (Step.startStable _ rfl rfl))
    (Step.clearExp _ rfl rfl)
