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
| `123` | fixed | the control's red line: `not ok 3 - gate collects every failure` | `1111111` |
| `#123` | refuted | the caller at `lib/land.mjs:12` already checks it | — |
| `C1-3` | fixed | the control's red line: `not ok 4 - merge lock` | `2222222` |
| `c1-3` | refuted | `grep -n mergeLock lib/land.mjs` shows the release at :876 | — |

### Negative controls

- **123** (the fix reverted):

  ```
  not ok 3 - gate collects every failure
  ```

- **C1-3** (the fix reverted):

  ```
  not ok 4 - merge lock
  ```

### Forks I decided that the brief did not settle

None.

### Claims no control measures

None.
