#!/bin/sh
# Ubuntu x86_64: obtain verified distribution packages without a system install.
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive_dir="$project_dir/.cache/ffmpeg-packages"
runtime_dir="$project_dir/.cache/ffmpeg"
mkdir -p "$archive_dir/partial" "$runtime_dir"
apt-get --download-only --yes --no-install-recommends \
  -o Debug::NoLocking=true -o "Dir::Cache::archives=$archive_dir" install ffmpeg
# Download the binary even on hosts where the ffmpeg package is already installed.
(cd "$archive_dir" && apt-get download ffmpeg)
for package in "$archive_dir"/*.deb; do dpkg-deb -x "$package" "$runtime_dir"; done
cat > "$runtime_dir/ffmpeg" <<'WRAPPER'
#!/bin/sh
set -eu
ffmpeg_runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec env LD_LIBRARY_PATH="$ffmpeg_runtime_dir/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$ffmpeg_runtime_dir/usr/bin/ffmpeg" "$@"
WRAPPER
chmod 755 "$runtime_dir/ffmpeg"
"$runtime_dir/ffmpeg" -hide_banner -encoders | sed -n '/h264_nvenc/p'
