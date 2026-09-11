# Formal model

`Protocol.lean` is a Lean 4 model of K's two-slot upgrade transaction with
machine-checked proofs of `never_dual_run`, `never_bricked` and `write_ahead`.

What the model is, what it does not say, how to reproduce it and how to keep
it in step with the code: https://botiverse.github.io/k-carrier/formal.html

```sh
elan run leanprover/lean4:stable lean formal/Protocol.lean
```
