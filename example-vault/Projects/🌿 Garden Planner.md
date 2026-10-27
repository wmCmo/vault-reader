---
tags: [project, garden]
status: in progress
season: Spring 2027
---
A balcony garden: tomatoes, basil and whatever survives.

![[garden.svg]]

> [!abstract] How this hub works
> Notes link **up** to this hub. The list below is a Dataview query, so it updates itself.

## Notes

```dataview
LIST
FROM "Notes"
WHERE contains(file.outlinks, this.file.link)
SORT file.mtime DESC
```

## Open questions

- [ ] Self-watering pots, or a drip line?
- [ ] Does basil really keep aphids off tomatoes? See [[Companion planting#Pairs that work]]
