Small snippets I keep reaching for.

## Debounce

```js
export function debounce(fn, ms = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
```

## Group by

```python
from collections import defaultdict

def group_by(items, key):
    groups = defaultdict(list)
    for item in items:
        groups[key(item)].append(item)
    return dict(groups)
```

> [!note]
> Inline code like `git switch -c feature` gets the same monospace styling.
