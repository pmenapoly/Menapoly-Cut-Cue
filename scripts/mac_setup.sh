#!/bin/bash
# Menapoly Cut Cue: guided setup for an Intel Mac (works on Apple Silicon too).
# It checks everything first and asks before installing anything. Nothing is installed without your "y".
# Secret values in .env are never printed; only whether each one is set.
#
#   cd ~/Menapoly-Cut-Cue && scripts/mac_setup.sh          (or: make mac-setup)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1
G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'
ok()   { echo "  ${G}✓${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; PROBLEMS=$((PROBLEMS + 1)); }
ask()  { local a; read -r -p "    $1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }
step() { echo; echo "${B}$*${N}"; }
PROBLEMS=0

[ "$(uname)" = "Darwin" ] || { echo "This script is for macOS."; exit 1; }

step "1. This Mac"
VER=$(sw_vers -productVersion); MAJOR=${VER%%.*}
ARCH=$(uname -m)
CPU=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "?")
RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
CORES=$(sysctl -n hw.logicalcpu)
FREE_GB=$(df -g "$ROOT" | awk 'NR==2 {print $4}')
if [ "$MAJOR" -ge 13 ]; then ok "macOS $VER"; elif [ "$MAJOR" -ge 12 ]; then warn "macOS $VER works, but Homebrew fully supports macOS 13 or newer"; else bad "macOS $VER is too old (need 12 or newer; 13+ recommended)"; fi
if [ "$ARCH" = "x86_64" ]; then ok "Intel processor: $CPU, $CORES threads"; else ok "Apple Silicon ($ARCH): supported too"; fi
if [ "$RAM_GB" -ge 16 ]; then ok "${RAM_GB} GB memory"; elif [ "$RAM_GB" -ge 8 ]; then warn "${RAM_GB} GB memory: use the Whisper 'base' model"; else bad "${RAM_GB} GB memory is below the 8 GB minimum"; fi
if [ "$FREE_GB" -ge 20 ]; then ok "${FREE_GB} GB free disk"; else warn "${FREE_GB} GB free disk: keep at least 20 GB free for footage and renders"; fi

step "2. Apple command line tools"
if xcode-select -p >/dev/null 2>&1; then ok "installed"
else
  bad "missing (needed by Homebrew and git)"
  if ask "Open Apple's installer for the command line tools now?"; then xcode-select --install; echo "    Finish the installer window, then run this script again."; exit 0; fi
fi

step "3. Homebrew (the package manager used for Python, Node.js and FFmpeg)"
if ! command -v brew >/dev/null 2>&1; then
  for p in /usr/local/bin/brew /opt/homebrew/bin/brew; do [ -x "$p" ] && eval "$("$p" shellenv)"; done
fi
if command -v brew >/dev/null 2>&1; then ok "$(brew --version | head -1)"
else
  bad "Homebrew is not installed"
  echo "    The official installer is: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
  if ask "Run the official Homebrew installer now? (it asks for your Mac password)"; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || { bad "Homebrew install failed"; exit 1; }
    for p in /usr/local/bin/brew /opt/homebrew/bin/brew; do [ -x "$p" ] && eval "$("$p" shellenv)"; done
  else echo "    Skipped. Install Homebrew, then run this script again."; exit 1; fi
fi

need_brew() { # $1 = formula, $2 = why
  if ask "Install $1 with Homebrew ($2)?"; then brew install "$1" && ok "$1 installed" || bad "brew install $1 failed"; else warn "skipped $1"; fi
}

step "4. Tools"
PY=""
for c in python3.12 /usr/local/opt/python@3.12/bin/python3.12 /opt/homebrew/opt/python@3.12/bin/python3.12; do command -v "$c" >/dev/null 2>&1 && { PY=$(command -v "$c"); break; }; done
if [ -n "$PY" ]; then ok "Python $($PY -V 2>&1 | cut -d' ' -f2) ($PY)"
else bad "Python 3.12 not found"; need_brew python@3.12 "the app's backend runs on it"
  for c in python3.12 /usr/local/opt/python@3.12/bin/python3.12 /opt/homebrew/opt/python@3.12/bin/python3.12; do command -v "$c" >/dev/null 2>&1 && { PY=$(command -v "$c"); break; }; done
fi
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then ok "Node.js $(node -v)"
else bad "Node.js 20 or newer not found"; need_brew node "builds the desktop app and runs the cloud tools"; fi
if command -v ffmpeg >/dev/null 2>&1; then
  ENC=$(ffmpeg -hide_banner -encoders 2>/dev/null)
  ok "FFmpeg $(ffmpeg -version | head -1 | cut -d' ' -f3)"
  echo "$ENC" | grep -q libx264 && ok "H.264 software encoder (libx264)" || bad "FFmpeg has no libx264 (reinstall with: brew reinstall ffmpeg)"
  echo "$ENC" | grep -q h264_videotoolbox && ok "H.264 hardware encoder (VideoToolbox) for faster final renders" || warn "no VideoToolbox encoder; renders use the CPU"
else bad "FFmpeg not found"; need_brew ffmpeg "it renders and analyses video"; fi
command -v git >/dev/null 2>&1 && ok "git $(git --version | cut -d' ' -f3)" || bad "git not found (comes with the command line tools)"
if [ -d "/Applications/Google Chrome.app" ]; then ok "Google Chrome"; else warn "Google Chrome not found: Cue works in Safari too, but the validation runs in Chrome"; fi

step "5. App dependencies (Python packages and the web app)"
if [ -x backend/.venv/bin/python ] && [ -d frontend/node_modules ]; then ok "already installed (run 'make setup' to refresh)"
elif [ -n "$PY" ] && ask "Install the app's own dependencies now (make setup, about 5 minutes)?"; then
  make setup PY="$PY" && ok "dependencies installed" || bad "make setup failed: see the messages above"
else warn "skipped: run 'make setup PY=python3.12' later"; fi

step "6. Your settings file (.env)"
if [ ! -f .env ]; then cp .env.example .env && ok "created .env from the template"; fi
chmod 600 .env && ok ".env is private to your user (permissions 600)"
setting() { grep -E "^$1=." .env >/dev/null 2>&1; }
for k in CUTCUE_TRANSCRIBER CUTCUE_WHISPER_MODEL ANTHROPIC_API_KEY CUTCUE_PASSWORD CUE_CLOUD_URL CUE_WORKER_TOKEN; do
  if setting "$k"; then
    case "$k" in ANTHROPIC_API_KEY|CUTCUE_PASSWORD|CUE_WORKER_TOKEN) ok "$k is set (value hidden)";; *) ok "$k = $(grep -E "^$k=" .env | head -1 | cut -d= -f2-)";; esac
  else
    case "$k" in
      ANTHROPIC_API_KEY) warn "$k not set: Cue uses its built-in planner (Claude is optional and paid)";;
      CUE_CLOUD_URL|CUE_WORKER_TOKEN) warn "$k not set: the Mac worker is configured after the private deployment";;
      *) warn "$k not set (the default is used)";;
    esac
  fi
done

step "7. Whisper speech model (downloaded once, about 150 MB for 'base')"
if compgen -G "$HOME/.cache/huggingface/hub/models--*faster-whisper*" >/dev/null; then ok "a Whisper model is already downloaded"
elif [ -x backend/.venv/bin/python ] && ask "Download the Whisper model now?"; then make whisper-model && ok "model ready" || bad "download failed"
else warn "skipped: it downloads on the first transcription"; fi

step "8. Cloud tools for the hybrid tests (optional; nothing is deployed)"
if [ -d cloud/control-plane/node_modules ]; then ok "installed"
elif command -v node >/dev/null 2>&1 && ask "Install the local cloud test tools (make cloud-setup)?"; then make cloud-setup && ok "installed" || bad "failed"
else warn "skipped: needed only for 'make validate' steps 19–21"; fi

step "Result"
if [ "$PROBLEMS" -eq 0 ]; then
  echo "  ${G}Ready.${N} Next:"
  echo "    scripts/cue_mac.sh start      # start Menapoly Cut Cue and open it in Chrome"
  echo "    make validate MEDIA=~/Movies/short-clip.mp4 CLIP_MINUTES=2    # real-media check"
else
  echo "  ${R}$PROBLEMS item(s) need attention${N}. Fix them (the lines with ✗), then run this script again."
fi
