#!/usr/bin/env bash
#
# gen-missing-thumbnails.sh — 为没有缩略图的视频补充缩略图, 并更新数据库
#
# 背景: browse server 对视频缩略图请求 (/media/{id}?t=1) 只读取 media 表
# thumbnail_download_path 指向的文件, 不存在即返回 404, 不会在线截帧
# (见 MediaRequestHandler.ts)。本脚本离线补充:
#
#   1. 帖子有图片 → 复制帖子里的第一张图片作为缩略图
#   2. 帖子没有图片 → 用 ffmpeg 从视频截取一帧 (优先取 3 秒处, 失败退回首帧)
#
# 生成的缩略图按下载器惯例存放: {帖子目录}/.thumbnails/{media_id}.{ext}
# 并写回 {dataDir}/.patreon-dl/db.sqlite 的 media 表:
#   thumbnail_download_path / thumbnail_mime_type / thumbnail_width / thumbnail_height
#
# 用法:
#   ./gen-missing-thumbnails.sh [-n] [--ffmpeg <路径>] <目录> [更多目录...]
#
#   <目录> 可以是:
#     - 博主下载目录 (其父目录含 .patreon-dl/db.sqlite): 只处理该博主
#     - dataDir 本身 (含 .patreon-dl/db.sqlite): 处理其中全部博主
#
# 选项:
#   -n, --dry-run     只显示将要执行的操作, 不写文件、不写数据库
#   --ffmpeg <路径>   指定 ffmpeg (默认 PATH 中的 ffmpeg, 也可用环境变量 FFMPEG)
#   --ffprobe <路径>  指定 ffprobe (默认 PATH 中的 ffprobe; 缺失时宽高写 NULL)
#   -h, --help        显示帮助
#
# 依赖: sqlite3 (必需; Ubuntu: sudo apt install sqlite3)
#       ffmpeg / ffprobe (截帧时必需; 仅复制图片时 ffprobe 用于读取宽高, 可缺)
#
# 数据库为 WAL 模式, 服务器运行期间执行本脚本是安全的 (带 30s 锁等待)。

set -u

DRY_RUN=0
FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"
SQLITE="${SQLITE_BIN:-sqlite3}"
declare -a USER_DIRS=()

SEP=$'\x1f'   # sqlite3 输出分隔符 (sanitize-filename 不会保留控制字符, 安全)

# ---------------------------------------------------------------- 用法 ----

usage() {
  cat <<EOF
用法: $(basename "$0") [-n] [--ffmpeg <路径>] <目录> [更多目录...]

为数据库中"已下载但没有可用缩略图"的视频补充缩略图:
  帖子有图片 → 复制第一张图片; 没有图片 → ffmpeg 截取一帧。
  结果写入 {dataDir}/.patreon-dl/db.sqlite 的 media 表。

<目录>: 博主下载目录 (只处理该博主) 或 dataDir 根目录 (处理全部)

选项:
  -n, --dry-run      只显示操作, 不写文件/数据库
  --ffmpeg <路径>    指定 ffmpeg 可执行文件
  --ffprobe <路径>   指定 ffprobe 可执行文件
  -h, --help         显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
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

ext_to_mime() {
  case "${1,,}" in
    jpg|jpeg) echo "image/jpeg" ;;
    png)      echo "image/png" ;;
    gif)      echo "image/gif" ;;
    webp)     echo "image/webp" ;;
    avif)     echo "image/avif" ;;
    bmp)      echo "image/bmp" ;;
    *)        echo "" ;;
  esac
}

# 读取图片/视频尺寸, 输出 "宽 高"; 失败时无输出
probe_dims() {
  command -v "$FFPROBE" &>/dev/null || return 1
  local out
  out=$("$FFPROBE" -v error -select_streams v:0 \
        -show_entries stream=width,height -of csv=p=0 "$1" 2>/dev/null) || return 1
  out=${out%$'\r'}   # 兼容 Windows 程序输出 CRLF
  # 尺寸必须为正整数 (无法解析的文件 ffprobe 可能返回 0,0)
  [[ "$out" =~ ^([1-9][0-9]*),([1-9][0-9]*)$ ]] && echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
}

# 用 ffmpeg 截取一帧作为 JPG (先取 3 秒处, 失败退回首帧); 缩放到最大宽 640
extract_frame() {
  local video=$1 out=$2
  rm -f -- "$out"
  if "$FFMPEG" -hide_banner -loglevel error -y -ss 3 -i "$video" \
       -vframes 1 -vf "scale='min(640,iw)':-2" -q:v 3 "$out" 2>/dev/null && \
     [[ -s "$out" ]]; then
    return 0
  fi
  rm -f -- "$out"
  "$FFMPEG" -hide_banner -loglevel error -y -ss 0 -i "$video" \
    -vframes 1 -vf "scale='min(640,iw)':-2" -q:v 3 "$out" 2>/dev/null && \
  [[ -s "$out" ]]
}

# 由媒体文件相对路径推算所属内容 (帖子/商品) 的根目录相对路径
# 媒体文件位于 {内容根}/{固定子目录}/文件, 固定子目录见 FSHelper.ts
content_root_of() {
  local dir base
  dir=$(dirname "$1")
  base=$(basename "$dir")
  case "$base" in
    post_info|audio|video|images|audio_preview|video_preview|image_previews|\
    attachments|embed|content_media|preview_media|.thumbnails)
      dirname "$dir" ;;
    *) echo "$dir" ;;
  esac
}

# ------------------------------------------------------- 解析输入目录 ----

DATA_DIR=""
declare -a PREFIXES=()   # 需要处理的博主目录前缀 (相对 dataDir); 空 = 全部

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
    echo "      请传入博主下载目录 (如 /data/downloads/creator-name) 或 dataDir 根目录" >&2
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

command -v "$SQLITE" &>/dev/null || {
  echo "错误: 未找到 sqlite3 命令, 请先安装: sudo apt install sqlite3" >&2
  exit 1
}

"$SQLITE" "$DB_FILE" ".timeout 30000" "SELECT 1 FROM media LIMIT 1;" >/dev/null 2>&1 || {
  echo "错误: 无法读取数据库或缺少 media 表: $DB_FILE" >&2
  exit 1
}

# --------------------------------------------------------- SQL 查询 ----

# 查询帖子内可用的第一张图片 (相对路径)
query_post_image() {
  local cid=$1 ctype=$2
  local esc_cid esc_ctype
  esc_cid=$(sql_escape "$cid")
  esc_ctype=$(sql_escape "$ctype")
  local result
  result=$("$SQLITE" "$DB_FILE" ".timeout 30000" \
    "SELECT m2.download_path
     FROM media m2
     JOIN content_media cm2 ON cm2.media_id = m2.media_id
     WHERE cm2.content_id = '$esc_cid' AND cm2.content_type = '$esc_ctype'
       AND m2.media_type = 'image'
       AND m2.download_path IS NOT NULL AND m2.download_path != ''
     ORDER BY cm2.media_index ASC, m2.media_id ASC
     LIMIT 1;" 2>/dev/null) || return 1
  printf '%s' "${result%$'\r'}"   # 去除可能的 CRLF 行尾
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

TOTAL=0 OK=0 COPIED=0 FRAMED=0 SKIPPED=0

process_video() {
  local media_id=$1 thumb_rel_db=$2 vid_rel=$3 content_id=$4 content_type=$5
  local vid_abs="$DATA_DIR/$vid_rel"
  local pfx=""
  [[ $DRY_RUN -eq 1 ]] && pfx="[dry-run] "

  # 情况 0: DB 中已有缩略图且文件存在且非空 → 跳过
  if [[ -n "$thumb_rel_db" ]] && is_usable_file "$DATA_DIR/$thumb_rel_db"; then
    OK=$((OK+1))
    return
  fi

  # 缩略图目标位置 (下载器惯例: {帖子目录}/.thumbnails/{media_id}.{ext})
  local root_rel thumb_dir_rel thumb_dir_abs
  root_rel=$(content_root_of "$vid_rel")
  thumb_dir_rel="$root_rel/.thumbnails"
  thumb_dir_abs="$DATA_DIR/$thumb_dir_rel"

  # 优先方案: 复制帖子里的第一张图片
  local img_rel="" img_abs=""
  if [[ -n "$content_id" ]]; then
    img_rel=$(query_post_image "$content_id" "$content_type")
    [[ -n "$img_rel" ]] && img_abs="$DATA_DIR/$img_rel"
  fi

  local ext="" mime="" src=""
  local target target_rel

  if [[ -n "$img_abs" ]] && is_usable_file "$img_abs"; then
    ext="${img_abs##*.}"; ext="${ext,,}"
    target="$thumb_dir_abs/$media_id.$ext"
    target_rel="$thumb_dir_rel/$media_id.$ext"
    if [[ $DRY_RUN -eq 0 ]]; then
      mkdir -p -- "$thumb_dir_abs"
      if ! is_usable_file "$target"; then
        cp -f -- "$img_abs" "$target" || {
          SKIPPED=$((SKIPPED+1))
          echo "[skip]  $media_id (复制帖子图片失败: $img_rel)" >&2
          return
        }
      fi
    fi
    src="copy"
    mime=$(ext_to_mime "$ext")
  elif is_usable_file "$vid_abs"; then
    if ! command -v "$FFMPEG" &>/dev/null; then
      SKIPPED=$((SKIPPED+1))
      echo "[skip]  $media_id (帖子无图片, 需要 ffmpeg 截帧但未找到 ffmpeg)" >&2
      return
    fi
    ext="jpg"
    target="$thumb_dir_abs/$media_id.jpg"
    target_rel="$thumb_dir_rel/$media_id.jpg"
    if [[ $DRY_RUN -eq 0 ]]; then
      mkdir -p -- "$thumb_dir_abs"
      if ! is_usable_file "$target"; then
        if ! extract_frame "$vid_abs" "$target"; then
          rm -f -- "$target"
          SKIPPED=$((SKIPPED+1))
          echo "[skip]  $media_id (ffmpeg 截帧失败: $vid_rel)" >&2
          return
        fi
      fi
    fi
    src="frame"
    mime="image/jpeg"
  else
    SKIPPED=$((SKIPPED+1))
    echo "[skip]  $media_id (帖子无图片且视频文件不存在: $vid_rel)" >&2
    return
  fi

  # 写库
  if [[ $DRY_RUN -eq 0 ]]; then
    local w="" h="" dims
    dims=$(probe_dims "$DATA_DIR/$target_rel") && { w=${dims% *}; h=${dims#* }; }
    local wsql="NULL" hsql="NULL" mime_sql="NULL"
    [[ "$w" =~ ^[1-9][0-9]*$ ]] && wsql="$w"
    [[ "$h" =~ ^[1-9][0-9]*$ ]] && hsql="$h"
    [[ -n "$mime" ]] && mime_sql="'$(sql_escape "$mime")'"
    "$SQLITE" "$DB_FILE" ".timeout 30000" \
      "UPDATE media
       SET thumbnail_download_path = '$(sql_escape "$target_rel")',
           thumbnail_mime_type = $mime_sql,
           thumbnail_width = $wsql,
           thumbnail_height = $hsql
       WHERE media_id = '$(sql_escape "$media_id")';" || {
        SKIPPED=$((SKIPPED+1))
        echo "[skip]  $media_id (更新数据库失败)" >&2
        return
      }
  fi

  if [[ "$src" == "copy" ]]; then
    COPIED=$((COPIED+1))
    echo "${pfx}[copy]  $media_id -> $target_rel (来源: 帖子图片 $(basename "$img_rel"))"
  else
    FRAMED=$((FRAMED+1))
    echo "${pfx}[frame] $media_id -> $target_rel (ffmpeg 截帧: $(basename "$vid_rel"))"
  fi
}

# ---------------------------------------------------------------- 主流程 ----

VIDEOS_SQL="SELECT m.media_id,
       COALESCE(m.thumbnail_download_path, ''),
       m.download_path,
       COALESCE(cm.content_id, ''),
       COALESCE(cm.content_type, '')
     FROM media m
     LEFT JOIN content_media cm ON cm.media_id = m.media_id
     WHERE m.media_type = 'video'
       AND m.download_path IS NOT NULL AND m.download_path != ''
     ORDER BY m.media_id;"

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  line=${line%$'\r'}   # 兼容 Windows sqlite3 的 CRLF 行尾
  IFS=$SEP read -r media_id thumb_rel vid_rel content_id content_type extra <<< "$line"
  if [[ -n "${extra:-}" ]]; then
    echo "警告: 记录解析异常, 已跳过: ${line:0:80}..." >&2
    continue
  fi
  in_scope "$vid_rel" || continue
  TOTAL=$((TOTAL+1))
  process_video "$media_id" "$thumb_rel" "$vid_rel" "$content_id" "$content_type"
done < <("$SQLITE" -separator "$SEP" "$DB_FILE" ".timeout 30000" "$VIDEOS_SQL")

scope_desc="全部"
[[ ${#PREFIXES[@]} -gt 0 ]] && scope_desc="${PREFIXES[*]}"
echo "----" >&2
echo "范围: $scope_desc (dataDir: $DATA_DIR)" >&2
echo "共检查 $TOTAL 个视频: 已有缩略图 $OK, 复制图片 $COPIED, 截取帧 $FRAMED, 跳过 $SKIPPED" >&2
[[ $DRY_RUN -eq 1 ]] && echo "(dry-run 模式, 未做任何修改)" >&2

exit 0
