# /mem-evict <slab_id>

Evict a slab from working memory slots, freeing them for new content.

## Steps
1. Read `/Users/ahmed/projects/mem-manager/page_directory.json`
2. Look up slab_id — get its assigned slots and keys
3. Check evictable: true — if false, abort with "Slab <id> is PINNED, cannot evict"
4. For each key in the slab: remove corresponding memory slot via memory_user_edits remove
5. Update page_directory.json: clear slab's slots array, set last_accessed
6. Confirm: "Evicted slab <id>, freed slots <n>–<m>"

## Safety
- Never evict pinned slabs: pinned, resume-rules, experience-anchors, page-directory
- Always write updated page_directory.json after eviction
