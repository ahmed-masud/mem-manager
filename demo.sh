#!/usr/bin/env bash
# =============================================================================
#  mem-manager demo — shows memory-aware Ollama in action
#  Run: bash /home/masud/mem-manager/demo.sh [model]
#  Default model: llama3.2:3b  (good balance of speed + accuracy)
# =============================================================================

MODEL=${1:-llama3.2:3b}
PROXY=http://localhost:11435
NATIVE=http://localhost:11434

# ANSI colors
BOLD='\033[1m';  RESET='\033[0m'
CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'
RED='\033[31m';  BLUE='\033[34m';  DIM='\033[2m'
MAGENTA='\033[35m'

hr() { echo -e "${DIM}────────────────────────────────────────────────────────${RESET}"; }

ask_ollama() {
  local host=$1 question=$2
  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({'model': sys.argv[1], 'messages': [{'role': 'user', 'content': sys.argv[2]}], 'stream': False}))
" "$MODEL" "$question")
  curl -s "$host/api/chat" \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    | python3 -c "
import sys, json
lines = [l for l in sys.stdin.read().strip().split('\n') if l.strip()]
obj = json.loads(lines[-1])
print(obj.get('message', {}).get('content') or obj.get('error') or 'No response')
"
}

clear
echo ""
echo -e "${BOLD}${CYAN}  🧠  mem-manager — Extended Memory for Local LLMs${RESET}"
echo -e "${DIM}  Gamgee · Ubuntu 24.04 · Ollama ${MODEL}${RESET}"
hr

# ── Step 1: Show loaded slabs ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}${YELLOW}  STEP 1 — What's in memory right now?${RESET}"
echo ""
cd /home/masud/mem-manager && node scripts/status.js | grep -v "^$" | sed 's/^/  /'
echo ""
read -p "  $(echo -e ${DIM})Press Enter to continue...$(echo -e ${RESET})"

# ── Step 2: Ask native Ollama (no memory) ───────────────────────────────────
clear
echo ""
echo -e "${BOLD}${CYAN}  🧠  mem-manager demo${RESET}"
hr
echo ""
echo -e "${BOLD}${RED}  STEP 2 — Native Ollama (port 11434, NO memory)${RESET}"
echo -e "${DIM}  Asking: \"Who am I and what do I have coming up this week?\"${RESET}"
echo ""
echo -e "${RED}  ┌─ Ollama (native) ─────────────────────────────────────┐${RESET}"
ask_ollama "$NATIVE" "Who am I and what do I have coming up this week?" \
  | fold -s -w 56 | sed 's/^/  │  /'
echo -e "${RED}  └───────────────────────────────────────────────────────┘${RESET}"
echo ""
echo -e "${DIM}  (No context — it has no idea who you are)${RESET}"
echo ""
read -p "  $(echo -e ${DIM})Press Enter to see the difference...$(echo -e ${RESET})"

# ── Step 3: Ask memory-aware proxy ──────────────────────────────────────────
clear
echo ""
echo -e "${BOLD}${CYAN}  🧠  mem-manager demo${RESET}"
hr
echo ""
echo -e "${BOLD}${GREEN}  STEP 3 — Memory-aware proxy (port 11435, WITH memory)${RESET}"
echo -e "${DIM}  Same question: \"Who am I and what do I have coming up this week?\"${RESET}"
echo ""
echo -e "${GREEN}  ┌─ Ollama + mem-manager ─────────────────────────────────┐${RESET}"
ask_ollama "$PROXY" "Who am I and what do I have coming up this week?" \
  | fold -s -w 56 | sed 's/^/  │  /'
echo -e "${GREEN}  └───────────────────────────────────────────────────────┘${RESET}"
echo ""

# ── Step 4: One more — specific memory test ──────────────────────────────────
echo -e "${DIM}  Trying another question...${RESET}"
echo ""
echo -e "${BOLD}${BLUE}  \"Based on my profile context, where do I live?\"${RESET}"
echo ""
echo -e "${GREEN}  ┌─ Ollama + mem-manager ─────────────────────────────────┐${RESET}"
ask_ollama "$PROXY" "Based on the profile context you have been given, what city and address do I live at? Just state what is in your context." \
  | fold -s -w 56 | sed 's/^/  │  /'
echo -e "${GREEN}  └───────────────────────────────────────────────────────┘${RESET}"
echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
hr
echo ""
echo -e "${BOLD}${MAGENTA}  How it works:${RESET}"
echo -e "  ${DIM}Every request to ${RESET}${CYAN}:11435${RESET}${DIM} automatically gets your"
echo -e "  loaded memory slabs injected as system context."
echo -e "  Swap slabs in/out via the web UI at${RESET} ${CYAN}http://10.0.0.208:3456/ui${RESET}"
echo ""
echo -e "  ${DIM}Load a slab:  ${RESET}${YELLOW}node scripts/load.js <slab-id>${RESET}"
echo -e "  ${DIM}Evict a slab: ${RESET}${YELLOW}node scripts/evict.js <slab-id>${RESET}"
echo -e "  ${DIM}Web UI:       ${RESET}${YELLOW}http://10.0.0.208:3456/ui${RESET}"
echo ""
hr
echo ""
