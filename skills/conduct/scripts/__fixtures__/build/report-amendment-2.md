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

## Amendment 2

| Comment | Verdict | Evidence | Commit |
|---|---|---|---|
| `4177234272` | fixed | red control: `not ok 3 - gate collects every failure` | `1111111` |
| `4177234275` | refuted | the caller at `lib/land.mjs:12` already checks it | — |

### Negative controls

- **4177234272** (the fix reverted):

  ```
  not ok 3 - gate collects every failure
  ```
