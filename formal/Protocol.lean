/- Lean 4 K-protocol model — machine-checked invariants of the two-slot upgrade
core. Compiles with the default leanprover/lean4:`stable` toolchain (v4.33.0)
and with v4.10.0.

Proved (for every machine reachable from init by legal transitions):
  * never-bricked   : stableOk is never emptied
  * never-dual-run  : the number of live incarnations never exceeds 1
  * journal-write-ahead : each entered phase was journaled first

NOTE (tooling lesson): declare proofs with `theorem` (not `lemma`) after a
multi-clause `def`/`inductive` block — `lemma` trips a parser quirk on the
available toolchains; `theorem` does not.
-/

inductive Phase where
  | idle | staged | readback | promoted | rolledBack
deriving DecidableEq

structure Machine where
  phase : Phase
  stableOk : Bool
  hasExp : Bool
  nLive : Nat
  journal : List Phase

def initMachine : Machine :=
  { phase := Phase.idle, stableOk := true, hasExp := false, nLive := 1, journal := [] }

-- Legal transitions (a faithful sub-relation of TRANSITIONS). Each step
-- journals its target phase (write-ahead) and never clears stableOk.
def step : Machine → Option Machine
  | { phase := Phase.idle, stableOk := s, hasExp := _, nLive := n, journal := j } =>
      some { phase := Phase.staged, stableOk := s, hasExp := true, nLive := n, journal := j ++ [Phase.staged] }
  | { phase := Phase.staged, stableOk := s, hasExp := _, nLive := _, journal := j } =>
      some { phase := Phase.readback, stableOk := s, hasExp := true, nLive := 1, journal := j ++ [Phase.readback] }
  | { phase := Phase.readback, stableOk := s, hasExp := _, nLive := _, journal := j } =>
      some { phase := Phase.promoted, stableOk := s, hasExp := false, nLive := 1, journal := j ++ [Phase.promoted] }
  | _ => none

-- Reachability: machine after n legal steps (stays put at a terminal phase).
def runStep : Nat → Machine
  | 0 => initMachine
  | k + 1 =>
      match step (runStep k) with
      | none => runStep k
      | some m' => m'

-- ===========================================================================
-- LEMMA 1 · never bricked
-- ===========================================================================

-- one step preserves a live stable slot
theorem step_preserves_stable (m m' : Machine) (hst : step m = some m') (hm : m.stableOk = true) :
    m'.stableOk = true := by
  cases m with
  | mk ph s hx n j =>
      cases ph with
      | idle => simp [step] at hst; rw [← hst]; simpa [Machine.stableOk] using hm
      | staged => simp [step] at hst; rw [← hst]; simpa [Machine.stableOk] using hm
      | readback => simp [step] at hst; rw [← hst]; simpa [Machine.stableOk] using hm
      | promoted => simp [step] at hst
      | rolledBack => simp [step] at hst

-- reachability preserves the stable slot, by induction on step count
theorem never_bricked : ∀ n, (runStep n).stableOk = true := by
  intro n
  induction n with
  | zero => simp [runStep, initMachine]
  | succ k ih =>
      unfold runStep
      cases h : step (runStep k) with
      | none => exact ih
      | some m' => exact step_preserves_stable (runStep k) m' h ih

-- ===========================================================================
-- LEMMA 2 · never dual run (nLive never exceeds 1)
-- ===========================================================================

theorem step_preserves_nlive (m m' : Machine) (hst : step m = some m') (hm : m.nLive ≤ 1) :
    m'.nLive ≤ 1 := by
  cases m with
  | mk ph s hx n j =>
      cases ph with
      | idle => simp [step] at hst; rw [← hst]; simpa [Machine.nLive] using hm
      | staged => simp [step] at hst; rw [← hst]; simp [Machine.nLive]
      | readback => simp [step] at hst; rw [← hst]; simp [Machine.nLive]
      | promoted => simp [step] at hst
      | rolledBack => simp [step] at hst

theorem never_dual_run : ∀ n, (runStep n).nLive ≤ 1 := by
  intro n
  induction n with
  | zero => simp [runStep, initMachine]
  | succ k ih =>
      unfold runStep
      cases h : step (runStep k) with
      | none => exact ih
      | some m' => exact step_preserves_nlive (runStep k) m' h ih

-- ===========================================================================
-- LEMMA 3 · journal write-ahead (an entered phase was journaled first)
-- ===========================================================================

theorem step_preserves_journal (m m' : Machine) (hst : step m = some m') :
    m'.phase ∈ m'.journal := by
  cases m with
  | mk ph s hx n j =>
      cases ph with
      | idle =>
          simp [step] at hst
          rw [← hst]
          simp [Machine.journal, Machine.phase, List.mem_append]
      | staged =>
          simp [step] at hst
          rw [← hst]
          simp [Machine.journal, Machine.phase, List.mem_append]
      | readback =>
          simp [step] at hst
          rw [← hst]
          simp [Machine.journal, Machine.phase, List.mem_append]
      | promoted => simp [step] at hst
      | rolledBack => simp [step] at hst

theorem journal_write_ahead : ∀ n, (runStep n).phase = Phase.idle ∨ (runStep n).phase ∈ (runStep n).journal := by
  intro n
  induction n with
  | zero => left; simp [runStep, initMachine]
  | succ k ih =>
      unfold runStep
      cases h : step (runStep k) with
      | none => exact ih
      | some m' =>
          right
          exact step_preserves_journal (runStep k) m' h

-- The three headline guarantees together, for the machine after every n steps.
theorem protocol_guarantees (n : Nat) :
    (runStep n).stableOk = true ∧ (runStep n).nLive ≤ 1
      ∧ ((runStep n).phase = Phase.idle ∨ (runStep n).phase ∈ (runStep n).journal) := by
  exact ⟨never_bricked n, never_dual_run n, journal_write_ahead n⟩
