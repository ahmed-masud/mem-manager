# /mem-load <slab_id>

Load a slab from the backing store into working memory slots.

## Steps
1. Read `/Users/ahmed/projects/mem-manager/store/master.csv`
2. Filter rows where slab_id = $ARGUMENTS
3. Read `/Users/ahmed/projects/mem-manager/page_directory.json`
4. Check free working slots (7–26) — if insufficient, prompt to evict first
5. Write each row's `content` into a memory slot via memory_user_edits add
6. Update page_directory.json: add slab entry with assigned slots and today's date
7. Confirm: "Loaded slab <id> → slots <n>–<m>"

## Eviction hint
If no free slots: suggest `evict pipeline-closed` or LRU slab from page directory.
