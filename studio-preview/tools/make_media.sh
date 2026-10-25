#!/bin/bash
# Generates the fictional demo clips and posters used by the Studio preview. Synthetic gradients, text and a tone:
# no real footage, people, brands or client material. Re-run after changing a clip; outputs go to ../media/.
set -eu
cd "$(dirname "$0")/.."
mkdir -p media
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
MONO=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf

clip() { # name w h seconds c0 c1 title subtitle hz
  local name=$1 w=$2 h=$3 s=$4 c0=$5 c1=$6 title=$7 sub=$8 hz=$9
  local big=$(( h / 9 )) small=$(( h / 20 ))
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "gradients=s=${w}x${h}:d=${s}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${w}:y1=${h}:speed=0.02:rate=24" \
    -f lavfi -i "sine=frequency=${hz}:duration=${s}:sample_rate=44100" \
    -filter_complex "[0:v]drawbox=x='(iw-ih/4)*(0.5+0.4*sin(t/2))':y=ih*0.62:w=ih/4:h=ih/4:color=white@0.18:t=fill,\
drawtext=fontfile=${FONT}:text='FICTIONAL DEMO':fontsize=${small}:fontcolor=white@0.85:x=w*0.06:y=h*0.08,\
drawtext=fontfile=${FONT}:text='${title}':fontsize=${big}:fontcolor=white:x=w*0.06:y=h*0.30,\
drawtext=fontfile=${FONT}:text='${sub}':fontsize=${small}:fontcolor=white@0.9:x=w*0.06:y=h*0.30+${big}*1.4,\
drawtext=fontfile=${MONO}:text='%{pts\\:hms}':fontsize=${small}:fontcolor=white@0.9:x=w*0.06:y=h*0.88[v];\
[1:a]volume=0.08[a]" \
    -map "[v]" -map "[a]" -c:v libx264 -profile:v baseline -pix_fmt yuv420p -crf 30 -preset veryfast \
    -c:a aac -b:a 48k -movflags +faststart "media/${name}.mp4"
  ffmpeg -hide_banner -loglevel error -y -ss 2 -i "media/${name}.mp4" -frames:v 1 -q:v 6 "media/${name}.jpg"
  # VP9/Opus copy: every Chromium build plays it (the automated tests' Chromium has no H.264 decoder).
  ffmpeg -hide_banner -loglevel error -y -i "media/${name}.mp4" -c:v libvpx-vp9 -b:v 0 -crf 42 -deadline realtime -cpu-used 8 \
    -c:a libopus -b:a 32k "media/${name}.webm"
}

clip nw-launch-v1 640 360 12 0x14183a 0x5b3fd6 'Spring Launch' 'Northwind Roasters (fictional) - cut v1' 220
clip nw-launch-v2 640 360 12 0x101530 0x7a4fe0 'Spring Launch' 'Northwind Roasters (fictional) - cut v2' 247
clip nw-reel 360 640 10 0x1a1240 0xb18cff 'Brew Tips' 'Short-form reel (fictional)' 262
clip hb-podcast 640 360 10 0x0e1a2b 0x2f6f8f 'Harborline Talks' 'Episode 12 (fictional)' 196
clip mn-coaching 640 360 8 0x120f2a 0x3d2a8a 'Cue Coaching' 'Getting started (fictional)' 174
ls -la media
