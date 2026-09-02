#!/usr/bin/env bash
#
# find-missing-videos.sh — 扫描 patreon-dl 某个博主的下载目录,
# 找出"有视频但未下载"的帖子并输出帖子 ID。
#
# 覆盖三类视频:
#   1. 内置视频 (postType: video_external_file) → 应位于 帖子目录/video/
#   2. 嵌入的 YouTube 视频 (postType: video_embed) → 应位于 帖子目录/embed/
#   3. 嵌入的 Vimeo 视频 (经 patreon-dl-vimeo.js 等外部下载器) → 同样位于 帖子目录/embed/
#
# 目录结构 (patreon-dl 默认):
#   {outDir}/{博主campaign目录}/posts/{帖子ID}[ - ]{标题}/
#       ├── post_info/info.txt      # 含 "ID: xxx" / "Type: video_external_file|video_embed|..."
#       ├── video/                   # 内置视频
#       └── embed/                   # embedded-video.txt + 下载成功的嵌入视频
#
# 用法:
#   ./find-missing-videos.sh <博主下载目录> [更多目录...]
#   ./find-missing-videos.sh -q <目录>      # 仅输出帖子 ID(便于脚本二次处理)
#
# 说明:
#   - 传入目录可以是: 博主 campaign 根目录(含 posts/)、posts/ 目录本身、
#     或 outDir 根目录(会自动遍历其中每个博主的 posts/)。
#   - 判定"已下载"的标准: 对应子目录中存在扩展名为视频格式且大小>0 的文件
#     (.part 临时文件、.txt 信息文件、缩略图图片均不算)。

set -u

# ---------------------------------------------------------------- 配置 ----

# 视频文件扩展名(EOR, find -iregex 使用)
VIDEO_EXTS='mp4|mkv|webm|mov|m4v|avi|ts|flv|wmv|mpg|mpeg|m2ts|mts|3gp|ogv|divx'

IDS_ONLY=0
declare -a USER_DIRS=()

# ---------------------------------------------------------------- 用法 ----

usage() {
  cat <<EOF
用法: $(basename "$0") [-q] <博主下载目录> [更多目录...]

选项:
  -q, --ids-only   仅输出帖子 ID, 不附带原因说明
  -h, --help       显示本帮助

示例:
  $(basename "$0") "/data/patreon/SomeCreator - Campaign"
  $(basename "$0") -q /data/patreon/            # 扫描 outDir 下所有博主
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -q|--ids-only) IDS_ONLY=1 ;;
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

# 判断目录中是否存在"已下载完成"的视频文件(非空、视频扩展名、非隐藏文件)
# 用法: has_video_file <目录>
has_video_file() {
  local d="$1"
  [[ -d "$d" ]] || return 1
  local f
  while IFS= read -r -d '' f; do
    if [[ -s "$f" ]]; then
      return 0
    fi
  done < <(find "$d" -maxdepth 1 -type f ! -name '.*' \
             -regextype posix-extended -iregex ".*\.($VIDEO_EXTS)" -print0 2>/dev/null)
  return 1
}

# 从 info.txt 中提取字段值(ID / Type), 遇到 Content: 行即停止
# (Content 正文可能多行且包含任意文本, 其后的字段不可信)
# 用法: get_info_field <info.txt路径> <字段名>
get_info_field() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  awk -v key="$key" '
    /^Content:/ { exit }
    index($0, key ": ") == 1 { print substr($0, length(key) + 3); exit }
  ' "$file"
}

# 从 embedded-video.txt 提取 Provider (YouTube / Vimeo / ...)
get_embed_provider() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  awk -F': ' '$1 == "Provider" { print $2; exit }' "$file"
}

# 从帖子目录名提取帖子 ID
# 默认格式: "{content.id}[ - ]?{content.name}"  →  "12345678 - 标题"
# 兜底格式: "{content.type}-{content.id}"        →  "post-12345678"
get_id_from_dirname() {
  local name="$1"
  if [[ "$name" =~ ^([0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^post-([0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

# ---------------------------------------------------------- 扫描单帖子 ----

# 用法: scan_post_dir <帖子目录路径>
scan_post_dir() {
  local postdir="$1"
  local name pid ptype reason provider

  name="$(basename "$postdir")"
  local info_file="$postdir/post_info/info.txt"
  local embed_txt="$postdir/embed/embedded-video.txt"

  # 帖子 ID: 优先 info.txt, 兜底目录名
  pid="$(get_info_field "$info_file" "ID")"
  if [[ -z "$pid" ]]; then
    pid="$(get_id_from_dirname "$name")"
  fi
  if [[ -z "$pid" ]]; then
    pid="?"
  fi

  # 帖子类型
  ptype="$(get_info_field "$info_file" "Type")"

  reason=""

  if [[ "$ptype" == "video_external_file" ]]; then
    # 内置视频: 应下载到 video/
    if ! has_video_file "$postdir/video"; then
      reason="内置视频未下载 (video/ 目录无视频文件)"
    fi

  elif [[ "$ptype" == "video_embed" ]]; then
    # 嵌入视频 (YouTube / Vimeo 等): 应下载到 embed/
    if ! has_video_file "$postdir/embed"; then
      provider="$(get_embed_provider "$embed_txt")"
      reason="嵌入视频未下载 (embed/ 目录无视频文件)"
      [[ -n "$provider" ]] && reason="嵌入视频未下载 [${provider}] (embed/ 目录无视频文件)"
    fi

  elif [[ "$ptype" == "podcast" ]]; then
    # podcast 帖子可能带视频文件; 仅当 video/ 目录已创建却没有视频时报告
    if [[ -d "$postdir/video" ]] && ! has_video_file "$postdir/video"; then
      reason="podcast 视频未下载 (video/ 目录为空)"
    fi

  elif [[ -z "$ptype" ]]; then
    # 没有 info.txt (未保存帖子信息或旧版本下载): 按目录内容兜底判断
    if [[ -f "$embed_txt" ]]; then
      if ! has_video_file "$postdir/embed"; then
        provider="$(get_embed_provider "$embed_txt")"
        reason="嵌入视频未下载 (无 info.txt, 按目录判断)"
        [[ -n "$provider" ]] && reason="嵌入视频未下载 [${provider}] (无 info.txt, 按目录判断)"
      fi
    elif [[ -d "$postdir/video" ]] && ! has_video_file "$postdir/video"; then
      reason="疑似内置视频未下载 (无 info.txt, video/ 目录为空)"
    fi
  fi

  if [[ -n "$reason" ]]; then
    if [[ $IDS_ONLY -eq 1 ]]; then
      echo "$pid"
    else
      printf '%s\t%s\n' "$pid" "$reason"
    fi
  fi
}

# ------------------------------------------------------- 定位 posts 目录 ----

# 将用户传入的目录解析为一个或多个 posts/ 目录
# 用法: resolve_posts_dirs <目录>  (结果追加到全局 POSTS_DIRS 数组)
declare -a POSTS_DIRS=()
resolve_posts_dirs() {
  local root="$1" child found=0
  if [[ -d "$root/posts" ]]; then
    POSTS_DIRS+=("$root/posts")
    return
  fi
  # outDir 根目录: 遍历其中每个博主的目录
  for child in "$root"/*/; do
    [[ -d "${child}posts" ]] || continue
    POSTS_DIRS+=("${child}posts")
    found=1
  done
  if [[ $found -eq 0 ]]; then
    # 无 campaign 的直接模式: 传入目录本身就是帖子目录的父目录
    POSTS_DIRS+=("$root")
  fi
}

# ---------------------------------------------------------------- 主流程 ----

for d in "${USER_DIRS[@]}"; do
  if [[ ! -d "$d" ]]; then
    echo "警告: 目录不存在, 已跳过: $d" >&2
    continue
  fi
  resolve_posts_dirs "$d"
done

if [[ ${#POSTS_DIRS[@]} -eq 0 ]]; then
  echo "错误: 未找到任何 posts/ 目录" >&2
  exit 1
fi

declare -i total=0
declare -i missing=0

for posts_dir in "${POSTS_DIRS[@]}"; do
  for postdir in "$posts_dir"/*/; do
    [[ -d "$postdir" ]] || continue
    # 跳过非帖子目录(帖子目录应含 post_info/, 或 video/embed 子目录, 或目录名可提取 ID)
    if [[ ! -d "$postdir/post_info" && ! -d "$postdir/video" && ! -d "$postdir/embed" ]] \
       && [[ -z "$(get_id_from_dirname "$(basename "$postdir")")" ]]; then
      continue
    fi
    total+=1
    out="$(scan_post_dir "$postdir")"
    if [[ -n "$out" ]]; then
      missing+=1
      echo "$out"
    fi
  done
done

if [[ $IDS_ONLY -eq 0 ]]; then
  echo "----" >&2
  echo "共扫描 ${total} 个帖子, 发现 ${missing} 个有视频但未下载。" >&2
fi

exit 0
