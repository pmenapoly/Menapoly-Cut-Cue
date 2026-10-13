"""Minimal validated FFmpeg edit engine for Menapoly Cut Cue."""
from pathlib import Path
import json
import subprocess
import tempfile


def probe_duration(path: str) -> float:
    result = subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','json',path],capture_output=True,text=True,check=True)
    return float(json.loads(result.stdout)['format']['duration'])


def render_segments(segments: list[dict], output: str) -> None:
    """Render ordered source clips into a single 1280x720 MP4. Requires FFmpeg."""
    if not segments:
        raise ValueError('At least one segment is required')
    with tempfile.TemporaryDirectory() as directory:
        pieces = []
        for index, segment in enumerate(segments):
            source = Path(segment['source']).resolve(strict=True)
            start, end = float(segment['start']), float(segment['end'])
            duration = probe_duration(str(source))
            if start < 0 or end <= start or end > duration + 0.05:
                raise ValueError(f'Invalid source range for segment {index}')
            piece = Path(directory) / f'clip_{index:04}.mp4'
            subprocess.run(['ffmpeg','-y','-ss',str(start),'-i',str(source),'-t',str(end-start),'-vf','scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1','-r','30','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2',str(piece)],check=True,capture_output=True)
            pieces.append(piece)
        manifest = Path(directory) / 'concat.txt'
        manifest.write_text(''.join(f"file '{piece}'\n" for piece in pieces))
        subprocess.run(['ffmpeg','-y','-f','concat','-safe','0','-i',str(manifest),'-c','copy',output],check=True,capture_output=True)

if __name__ == '__main__':
    import sys
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python edit_engine.py edit.json output.mp4')
    render_segments(json.loads(Path(sys.argv[1]).read_text())['segments'],sys.argv[2])
