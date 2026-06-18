# /mem-status

Show the current state of the memory page directory.

## Steps
1. Read `/Users/ahmed/projects/mem-manager/page_directory.json`
2. Display a table: slab | keys loaded | slots used | evictable | last accessed
3. Show free slot count and scratch slot availability
4. Flag any slabs where last_accessed > 14 days ago as STALE
