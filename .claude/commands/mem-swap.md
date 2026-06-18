# /mem-swap <evict_slab> <load_slab>

Atomic evict + load in one operation.

## Steps
1. Run /mem-evict <evict_slab>
2. Run /mem-load <load_slab>
3. Report net slot change

## Auto-swap (no args)
If called with just a context hint (e.g. "/mem-swap for ncc interview prep"):
1. Read page_directory.json
2. Find LRU evictable slab (oldest last_accessed, evictable: true)
3. Evict it
4. Load the requested slab
5. Report what was swapped

## Common swaps
- ncc-interview-prep ↔ pipeline-closed   (before NCC technical interview)
- payments-prep ↔ pipeline-closed         (before Payments Canada build)
