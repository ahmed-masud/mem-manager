# mem-manager

A software-managed virtual memory system for Claude's 30-slot persistent memory.

## Concept

Claude's memory has 30 slots × 100K chars each = 3MB of "RAM".
This project treats that RAM like a CPU cache, with a Google Sheet / local CSV as the backing store (disk).

```
Google Sheet / master.csv   →   "disk"   (unlimited rows)
30 memory slots             →   "RAM"    (working set)
Categories / slabs          →   "pages"  (evict/load as units)
page_directory.json         →   "TLB"    (what's currently loaded)
```

## Slot Layout

| Slots  | Type      | Contents                                 |
|--------|-----------|------------------------------------------|
| 1–5    | PINNED    | Personal, resume rules, experience anchors |
| 6      | PAGE DIR  | Slab manifest — what's loaded & where   |
| 7–26   | WORKING   | Active pipeline, context, interview prep |
| 27–30  | SCRATCH   | Temp during /build /triage — then evict |

## Commands

```
/mem status          → show page directory (what's loaded)
/mem load <slab>     → page-in a slab from store/ into working slots
/mem evict <slab>    → page-out a slab, free working slots
/mem swap <slab>     → evict LRU slab, load new one
/mem sync            → push current slots back to master.csv
/mem audit           → check for stale/dated entries
```

## Slab Definitions

| Slab ID              | Description                              | Evictable |
|----------------------|------------------------------------------|-----------|
| pinned               | Address, resume rules, experience anchors| NO        |
| pipeline-active      | Active job applications                  | YES (LRU) |
| pipeline-closed      | Rejected / skipped applications          | YES       |
| contacts             | Recruiters, HR contacts, companies       | YES       |
| interview-prep       | Per-company interview prep notes         | YES       |
| resume-rules         | Stack inventory, disclosure rules        | NO        |
| experience-anchors   | F5, Kaiser, Allen & Unwin, CWID stories  | NO        |

## Files

```
mem-manager/
├── README.md
├── page_directory.json       # TLB — current slot state
├── store/
│   └── master.csv            # Full backing store (all memories)
├── slabs/
│   ├── pinned.csv
│   ├── pipeline-active.csv
│   ├── pipeline-closed.csv
│   ├── contacts.csv
│   ├── resume-rules.csv
│   └── experience-anchors.csv
├── scripts/
│   ├── load.js               # Load slab into memory slots
│   ├── evict.js              # Evict slab, free slots
│   ├── status.js             # Show page directory
│   └── sync.js               # Sync slots ↔ master.csv
└── .claude/commands/
    ├── mem-load.md
    ├── mem-evict.md
    ├── mem-status.md
    └── mem-swap.md
```
