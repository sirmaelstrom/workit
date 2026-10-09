# Lane report (authored test input)

## Outcome

built

## PR

#{pr} · {head}

## Runtime exercise

`cat hello.txt` printed `hi`.

Verdict: exercised
Would have shown: cat: hello.txt: No such file or directory

## Debrief

### Forks I decided that the brief did not settle

None.

### Claims no control measures

None.

## Amendment 1

| Comment | Verdict | Evidence | Commit |
|---|---|---|---|
| `C1-1` | fixed | the control's red line: `not ok 4 - merge lock` | `2222222` |
| `C1-2` | refuted | `grep -n mergeLock lib/land.mjs` shows the release at :876 | — |

### Negative controls

- **C1-1** (the fix reverted):

  ```
  not ok 4 - merge lock
  ```

### Forks I decided that the brief did not settle

None.

### Claims no control measures

None.
