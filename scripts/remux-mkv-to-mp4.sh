#!/usr/bin/env bash
#
# remux-mkv-to-mp4.sh — 将 MKV 视频转为浏览器兼容的 MP4, 并同步更新数据库
#
# 背景: browse server 通过 media 表的 download_path 定位视频文件。
# 把 video.mkv 换成 video.mp4 后, 必须同步更新 DB, 否则视频会 404。
# 本脚本在 remux 成功且 DB 更新成功后才删除原 MKV, 全程原子安全。
#
# 处理策略 (对每个 DB 中登记的 .mkv 视频, 自动 ffprobe 检测):
#   1. 视频兼容 + 音频兼容 (H.264/yuv420p + AAC/MP3/无音轨):
#      无损 remux — ffmpeg -c copy, 秒级完成, 无质量损失
#   2. 视频兼容 + 音频不兼容 (如 H.264 + Opus/AC3):
#      视频流无损 copy, 仅音频重编码为 AAC — 依然很快, 视频零损失
#   3. 视频不兼容 (HEVC/VP9/10bit...): 默认跳过并提示;
#      加 --transcode 后整体转码 (libx264 -crf 20 + AAC)
#
# 每步动作:
#   remux/转码到 *.mp4.tmp → 校验非空 → 改名为 *.mp4
#   → 更新 DB (download_path + mime_type, 并校验确实更新了 1 行)
#   → 删除原 .mkv (除非 --keep)
#
# 自愈: DB 指向 .mkv 但文件已是 .mp4 (如此前转换后又被下载任务回写),
#       或 mkv/mp4 并存 — 直接把 DB 修正为 .mp4, 重跑本脚本即可修复。
#
# 警告: 不要在下载任务运行期间执行本脚本! 下载器的 saveMedia 可能把
#       已转换记录回写成 .mkv, 造成 DB 与文件不一致 (播放 404)。
#
# 用法:
#   ./remux-mkv-to-mp4.sh [选项] <目录> [更多目录...]
#
#   <目录>: 博主下载目录 (只处理该博主) 或 dataDir 根目录 (处理全部)
#
# 选项:
#   -n, --dry-run     只显示将要执行的操作, 不改文件、不写数据库
#   --transcode       不兼容编码也转码 (慢, 无损优先方案失效时使用)
#   --keep            保留原 .mkv 文件 (默认成功后删除以省空间)
#   --ffmpeg <路径>   指定 ffmpeg
#   --ffprobe <路径>  指定 ffprobe
#   -h, --help        显示帮助
#
# 依赖: sqlite3 (Ubuntu: sudo apt install sqlite3), ffmpeg, ffprobe
# 数据库为 WAL 模式, 服务器运行期间执行安全 (带 30s 锁等待)。

set -u

DRY_RUN=0
TRANSCODE=0
KEEP=0
FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"
SQLITE="${SQLITE_BIN:-sqlite3}"
declare -a USER_DIRS=()

SEP=$'\x1f'

# ---------------------------------------------------------------- 用法 ----

usage() {
  cat <<EOF
用法: $(basename "$0") [-n] [--transcode] [--keep] <目录> [更多目录...]

将数据库中登记的 .mkv 视频转为浏览器兼容的 .mp4:
  视频音频均兼容 → 无损 remux, 秒级完成;
  仅音频不兼容 (Opus/AC3 等) → 视频无损 copy + 音频转 AAC;
  视频不兼容 → 默认跳过, 加 --transcode 整体转码。
  成功后自动更新数据库并删除原 .mkv (--keep 可保留)。

<目录>: 博主下载目录 (只处理该博主) 或 dataDir 根目录 (处理全部)

选项:
  -n, --dry-run     只显示操作, 不修改任何内容
  --transcode       不兼容编码也转码 (重新编码, 较慢)
  --keep            保留原 .mkv 文件
  --ffmpeg <路径>   指定 ffmpeg 可执行文件
  --ffprobe <路径>  指定 ffprobe 可执行文件
  -h, --help        显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    --transcode) TRANSCODE=1 ;;
    --keep) KEEP=1 ;;
    --ffmpeg)
      [[ $# -ge 2 ]] || { echo "错误: --ffmpeg 需要一个参数" >&2; exit 1; }
      FFMPEG=$2; shift ;;
    --ffprobe)
      [[ $# -ge 2 ]] || { echo "错误: --ffprobe 需要一个参数" >&2; exit 1; }
      FFPROBE=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "未知选项: $1" >&2; usage >&2; exit 1 ;;
    *)  USER_DIRS+=("$1") ;;
  esac
  shift
done

if [[ ${#USER_DIRS[@]} -eq 0 ]]; then
  usage >&2
  exit 1
fi

# ------------------------------------------------------------ 工具函数 ----

sql_escape() { local s=$1; s=${s//\'/\'\'}; printf '%s' "$s"; }
is_usable_file() { [[ -f "$1" && -s "$1" ]]; }

# 探测流信息; 设置 V_CODEC / V_PIXFMT / A_CODEC / HAS_SUBTITLE
# 注意: ffprobe 的 csv 多字段输出顺序不可控, 因此每个字段单独查询
declare V_CODEC="" V_PIXFMT="" A_CODEC="" HAS_SUBTITLE=0
probe_streams() {
  local f=$1
  V_CODEC=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=codec_name \
              -of csv=p=0 "$f" 2>/dev/null)
  V_PIXFMT=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=pix_fmt \
               -of csv=p=0 "$f" 2>/dev/null)
  A_CODEC=$("$FFPROBE" -v error -select_streams a:0 -show_entries stream=codec_name \
              -of csv=p=0 "$f" 2>/dev/null)
  if [[ -n $("$FFPROBE" -v error -select_streams s -show_entries stream=codec_name \
               -of csv=p=0 "$f" 2>/dev/null) ]]; then
    HAS_SUBTITLE=1
  else
    HAS_SUBTITLE=0
  fi
  V_CODEC=${V_CODEC%$'\r'}
  V_PIXFMT=${V_PIXFMT%$'\r'}
  A_CODEC=${A_CODEC%$'\r'}
  [[ -n "$V_CODEC" ]]
}

# 视频流可直接 copy 进 MP4 且浏览器 (含 Safari/iOS) 能播?
# H.264 + 8bit yuv420p
video_ok() {
  [[ "$V_CODEC" == "h264" ]] || return 1
  [[ "$V_PIXFMT" == "yuv420p" || "$V_PIXFMT" == "yuvj420p" ]]
}

# 音频流可直接 copy 进 MP4? (AAC / MP3 / 无音轨; Opus/AC3 等浏览器兼容性差)
audio_ok() {
  [[ -z "$A_CODEC" || "$A_CODEC" == "aac" || "$A_CODEC" == "mp3" ]]
}

codec_desc() {
  local a="无音轨"
  [[ -n "$A_CODEC" ]] && a="$A_CODEC"
  echo "$V_CODEC/$V_PIXFMT + $a"
}

# ------------------------------------------------------- 解析输入目录 ----

DATA_DIR=""
declare -a PREFIXES=()

for d in "${USER_DIRS[@]}"; do
  [[ -d "$d" ]] || { echo "错误: 目录不存在: $d" >&2; exit 1; }
  d=${d%/}
  local_dd=""
  if [[ -f "$d/.patreon-dl/db.sqlite" ]]; then
    local_dd="$d"
  elif [[ -f "${d%/*}/.patreon-dl/db.sqlite" ]]; then
    local_dd="${d%/*}"
    PREFIXES+=("$(basename "$d")/")
  else
    echo "错误: 在 $d 及其父目录中均未找到 .patreon-dl/db.sqlite" >&2
    echo "      请传入博主下载目录或 dataDir 根目录" >&2
    exit 1
  fi
  if [[ -z "$DATA_DIR" ]]; then
    DATA_DIR="$local_dd"
  elif [[ "$DATA_DIR" != "$local_dd" ]]; then
    echo "错误: 多个目录属于不同的 dataDir (\"$DATA_DIR\" 与 \"$local_dd\")" >&2
    exit 1
  fi
done

DB_FILE="$DATA_DIR/.patreon-dl/db.sqlite"

for tool in "$SQLITE" "$FFMPEG" "$FFPROBE"; do
  command -v "$tool" &>/dev/null || {
    echo "错误: 未找到命令: $tool" >&2
    exit 1
  }
done

"$SQLITE" "$DB_FILE" ".timeout 30000" "SELECT 1 FROM media LIMIT 1;" >/dev/null 2>&1 || {
  echo "错误: 无法读取数据库或缺少 media 表: $DB_FILE" >&2
  exit 1
}

in_scope() {
  [[ ${#PREFIXES[@]} -eq 0 ]] && return 0
  local p
  for p in "${PREFIXES[@]}"; do
    [[ "$1" == "$p"* ]] && return 0
  done
  return 1
}

# ------------------------------------------------------- 处理单个视频 ----

TOTAL=0 REMUXED=0 TRANSCODED=0 REPAIRED=0 SKIPPED=0

# 更新 media 表的 download_path/mime_type。
# 关键: UPDATE 匹配 0 行时 sqlite3 退出码仍是 0, 必须用 changes() 校验
# 确实更新了 1 行, 否则会静默失败 (文件已删、DB 未改 → 播放 404)。
db_update_path() {
  local media_id=$1 new_rel=$2 out
  out=$("$SQLITE" "$DB_FILE" ".timeout 30000" \
    "UPDATE media
     SET download_path = '$(sql_escape "$new_rel")',
         mime_type = 'video/mp4'
     WHERE media_id = '$(sql_escape "$media_id")';
     SELECT changes();") || return 1
  out=${out%$'\r'}
  [[ "$out" == "1" ]]
}

# 执行 ffmpeg 转换; 模式: remux(全copy) / audio(视频copy+音频转AAC) / transcode(全转码)
run_ffmpeg() {
  local in=$1 out=$2 mode=$3
  local -a args=( -hide_banner -loglevel error -y -i "$in" -map 0:v:0 )
  [[ -n "$A_CODEC" ]] && args+=( -map 0:a:0 )
  case "$mode" in
    remux)
      args+=( -c copy ) ;;
    audio)
      # 视频无损 copy, 仅音频重编码为 AAC (快, 视频零损失)
      args+=( -c:v copy -c:a aac -b:a 192k ) ;;
    transcode)
      args+=( -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p )
      [[ -n "$A_CODEC" ]] && args+=( -c:a aac -b:a 192k ) ;;
  esac
  args+=( -movflags +faststart -f mp4 "$out" )
  rm -f -- "$out"
  "$FFMPEG" "${args[@]}" 2>/dev/null && [[ -s "$out" ]]
}

process_video() {
  local media_id=$1 mkv_rel=$2
  local mkv_abs="$DATA_DIR/$mkv_rel"
  local mp4_rel="${mkv_rel%.*}.mp4"
  local mp4_abs="$DATA_DIR/$mp4_rel"
  local tmp_abs="$mp4_abs.tmp"
  local pfx=""
  [[ $DRY_RUN -eq 1 ]] && pfx="[dry-run] "

  if ! is_usable_file "$mkv_abs"; then
    # 自愈: mkv 不存在但同名 mp4 存在 → 此前已转换过, 只是 DB 未更新
    # (典型成因: 转换后下载任务的 saveMedia 又把路径回写成了 .mkv)
    if is_usable_file "$mp4_abs"; then
      if [[ $DRY_RUN -eq 1 ]]; then
        REPAIRED=$((REPAIRED+1))
        echo "${pfx}[repair] $media_id: 文件已是 .mp4 但 DB 仍指向 .mkv → 将更新数据库: $mp4_rel"
        return
      fi
      if db_update_path "$media_id" "$mp4_rel"; then
        REPAIRED=$((REPAIRED+1))
        echo "[repair] $media_id: 数据库已修复 → $mp4_rel"
      else
        SKIPPED=$((SKIPPED+1))
        echo "[skip]  $media_id (数据库修复失败: $mp4_rel)" >&2
      fi
      return
    fi
    SKIPPED=$((SKIPPED+1))
    echo "[skip]  $media_id (MKV 文件不存在或为空: $mkv_rel)" >&2
    return
  fi
  if [[ -e "$mp4_abs" ]]; then
    # mkv 与 mp4 同时存在 (如转换后下载任务又重新下载了 mkv):
    # 让 DB 指向可播放的 .mp4, 两个文件都保留
    if is_usable_file "$mp4_abs"; then
      if [[ $DRY_RUN -eq 1 ]]; then
        REPAIRED=$((REPAIRED+1))
        echo "${pfx}[repair] $media_id: mkv/mp4 并存, DB 指向 .mkv → 将改指 .mp4: $mp4_rel"
      elif db_update_path "$media_id" "$mp4_rel"; then
        REPAIRED=$((REPAIRED+1))
        echo "[repair] $media_id: mkv/mp4 并存, 数据库已改指 .mp4 (mkv 保留, 可自行删除)"
      else
        SKIPPED=$((SKIPPED+1))
        echo "[skip]  $media_id (mkv/mp4 并存但数据库更新失败)" >&2
      fi
    else
      SKIPPED=$((SKIPPED+1))
      echo "[skip]  $media_id (目标 .mp4 存在但为空文件, 请人工检查: $mp4_rel)" >&2
    fi
    return
  fi
  if ! probe_streams "$mkv_abs"; then
    SKIPPED=$((SKIPPED+1))
    echo "[skip]  $media_id (ffprobe 无法读取流信息: $mkv_rel)" >&2
    return
  fi

  local mode=""
  if video_ok && audio_ok; then
    mode="remux"
  elif video_ok; then
    # 视频兼容但音频不兼容 (Opus/AC3 等): 视频无损 copy, 仅音频转 AAC
    mode="audio"
  elif [[ $TRANSCODE -eq 1 ]]; then
    mode="transcode"
  else
    SKIPPED=$((SKIPPED+1))
    echo "[skip]  $media_id (视频编码 $(codec_desc) 浏览器不兼容, 加 --transcode 转码)" >&2
    return
  fi

  local sub_note=""
  [[ $HAS_SUBTITLE -eq 1 ]] && sub_note=" [注: 内嵌字幕流将被丢弃]"

  if [[ $DRY_RUN -eq 0 ]]; then
    if ! run_ffmpeg "$mkv_abs" "$tmp_abs" "$mode"; then
      rm -f -- "$tmp_abs"
      SKIPPED=$((SKIPPED+1))
      echo "[skip]  $media_id (ffmpeg $mode 失败: $mkv_rel)" >&2
      return
    fi
    mv -f -- "$tmp_abs" "$mp4_abs"
    # DB 更新成功 (且确实更新了 1 行) 才删原文件
    if ! db_update_path "$media_id" "$mp4_rel"; then
      SKIPPED=$((SKIPPED+1))
      echo "[skip]  $media_id (更新数据库失败, 已保留原文件)" >&2
      rm -f -- "$mp4_abs"
      return
    fi
    if [[ $KEEP -eq 0 ]]; then
      rm -f -- "$mkv_abs"
    fi
  fi

  if [[ "$mode" == "remux" ]]; then
    REMUXED=$((REMUXED+1))
    echo "${pfx}[remux] $media_id: $mkv_rel -> $mp4_rel (无损)${sub_note}"
  elif [[ "$mode" == "audio" ]]; then
    REMUXED=$((REMUXED+1))
    echo "${pfx}[audio] $media_id: $mkv_rel -> $mp4_rel (视频无损, 音频 $A_CODEC -> AAC)${sub_note}"
  else
    TRANSCODED=$((TRANSCODED+1))
    echo "${pfx}[xcode] $media_id: $mkv_rel -> $mp4_rel (转码 $(codec_desc) -> H.264/AAC)${sub_note}"
  fi
}

# ---------------------------------------------------------------- 主流程 ----

MKVS_SQL="SELECT media_id, download_path
     FROM media
     WHERE media_type = 'video'
       AND lower(download_path) LIKE '%.mkv'
     ORDER BY media_id;"

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  line=${line%$'\r'}
  IFS=$SEP read -r media_id mkv_rel extra <<< "$line"
  if [[ -n "${extra:-}" ]]; then
    echo "警告: 记录解析异常, 已跳过: ${line:0:80}..." >&2
    continue
  fi
  in_scope "$mkv_rel" || continue
  TOTAL=$((TOTAL+1))
  process_video "$media_id" "$mkv_rel"
done < <("$SQLITE" -separator "$SEP" "$DB_FILE" ".timeout 30000" "$MKVS_SQL")

scope_desc="全部"
[[ ${#PREFIXES[@]} -gt 0 ]] && scope_desc="${PREFIXES[*]}"
echo "----" >&2
echo "范围: $scope_desc (dataDir: $DATA_DIR)" >&2
echo "共检查 $TOTAL 个 MKV: remux $REMUXED, 转码 $TRANSCODED, 修复 $REPAIRED, 跳过 $SKIPPED" >&2
[[ $KEEP -eq 1 ]] && echo "(--keep: 原文件已保留)" >&2
[[ $DRY_RUN -eq 1 ]] && echo "(dry-run 模式, 未做任何修改)" >&2

exit 0
