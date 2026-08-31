/**
 * Bilingual UI dictionary. English is the default; Chinese is opt-in from the
 * settings panel. Each key maps to both languages so the whole front end can
 * switch with one state change.
 */
export type AppLanguage = 'en' | 'zh';

export type TranslationKey = keyof typeof translations;

export interface TranslationEntry {
  en: string;
  zh: string;
}

export const translations = {
  // ---- Navigation / sidebar ----
  nav_home: { en: 'Home', zh: '首页' },
  nav_search: { en: 'Search', zh: '搜索' },
  nav_favorites: { en: 'Favorites', zh: '收藏' },
  nav_history: { en: 'History', zh: '历史' },
  nav_users: { en: 'Users', zh: '用户' },
  nav_transcription: { en: 'Transcription', zh: '转录' },
  nav_settings: { en: 'Settings', zh: '设置' },
  nav_signout: { en: 'Sign out', zh: '退出登录' },
  nav_creators: { en: 'Creators', zh: '创作者' },
  expand: { en: 'Expand', zh: '展开' },
  collapse: { en: 'Collapse', zh: '收起' },
  order: { en: 'Order', zh: '排序' },
  order_creators_aria: { en: 'Order creators by', zh: '按创作者排序' },
  sort: { en: 'Sort', zh: '排序' },
  open_menu_aria: { en: 'Open menu', zh: '打开菜单' },

  // ---- Quota ----
  quota_today: { en: "Today's allowance", zh: '今日额度' },
  quota_posts: { en: 'Posts', zh: '帖子' },
  quota_videos: { en: 'Videos', zh: '视频' },
  quota_unlimited: { en: 'Unlimited', zh: '无限制' },
  quota_tooltip: {
    en: 'Resets at 08:00 Beijing time ({time}). Opening the same post or video again is free.',
    zh: '每天 08:00（北京时间）重置（{time}）。重复打开同一帖子或视频不消耗额度。'
  },

  // ---- Sort options ----
  sort_most_media: { en: 'Most media', zh: '媒体最多' },
  sort_most_content: { en: 'Most content', zh: '内容最多' },
  sort_last_downloaded: { en: 'Last downloaded', zh: '最近下载' },
  sort_last_created: { en: 'Last created', zh: '最近创建' },
  sort_last_updated: { en: 'Last updated', zh: '最近更新' },
  sort_best_match: { en: 'Best match', zh: '最佳匹配' },
  sort_latest: { en: 'Latest', zh: '最新' },
  sort_oldest: { en: 'Oldest', zh: '最早' },

  // ---- Showing text ----
  showing_range: { en: 'Showing {start} - {end} of {total} {subject}', zh: '显示第 {start} - {end} 条，共 {total} 条{subject}' },
  total_count: { en: 'Total {total} {subject}', zh: '共 {total} 条{subject}' },

  // ---- Subjects (singular / plural collapse to one Chinese word) ----
  subject_creator: { en: 'creator', zh: '创作者' },
  subject_creators: { en: 'creators', zh: '创作者' },
  subject_post: { en: 'post', zh: '帖子' },
  subject_posts: { en: 'posts', zh: '帖子' },
  subject_product: { en: 'product', zh: '商品' },
  subject_products: { en: 'products', zh: '商品' },
  subject_collection: { en: 'collection', zh: '收藏夹' },
  subject_collections: { en: 'collections', zh: '收藏夹' },

  // ---- Settings modal ----
  settings_list_per_page: { en: 'List items per page:', zh: '每页列表条数：' },
  settings_gallery_per_page: { en: 'Gallery items per page:', zh: '每页图库条数：' },
  settings_max_width: { en: 'Max. content width:', zh: '最大内容宽度：' },
  settings_language: { en: 'Language:', zh: '语言：' },
  option_english: { en: 'English', zh: '英语' },
  option_chinese: { en: '中文', zh: '中文' },

  // ---- Login ----
  login_username: { en: 'Username', zh: '用户名' },
  login_password: { en: 'Password', zh: '密码' },
  login_confirm_password: { en: 'Confirm password', zh: '确认密码' },
  login_enter_username: { en: 'Enter your username', zh: '请输入用户名' },
  login_enter_password: { en: 'Enter your password', zh: '请输入密码' },
  login_choose_username: { en: 'Choose a username', zh: '请选择一个用户名' },
  login_username_max: { en: 'At most 32 characters', zh: '最多 32 个字符' },
  login_choose_password: { en: 'Choose a password', zh: '请选择一个密码' },
  login_password_min: { en: 'At least 6 characters', zh: '至少 6 个字符' },
  login_type_password_again: { en: 'Type the password again', zh: '请再次输入密码' },
  login_password_mismatch: { en: 'The two passwords do not match', zh: '两次输入的密码不一致' },
  login_signin: { en: 'Sign in', zh: '登录' },
  login_no_account: { en: 'No account?', zh: '没有账号？' },
  login_apply: { en: 'Apply for one', zh: '申请一个' },
  login_send_application: { en: 'Send application', zh: '提交申请' },
  login_admin_reviews: { en: 'An administrator reviews every application.', zh: '管理员会审核每一份申请。' },
  login_back_to_signin: { en: 'Back to sign in', zh: '返回登录' },
  login_sent_for: { en: 'Sent for "{name}"', zh: '已为"{name}"提交申请' },
  login_approval_note: { en: 'An administrator has to approve it before you can sign in.', zh: '在你登录之前，需要管理员批准该申请。' },

  // ---- Home / creator list ----
  creators_heading: { en: 'Creators', zh: '创作者' },

  // ---- Search ----
  search_heading: { en: 'Search', zh: '搜索' },
  search_placeholder: { en: 'Search posts from every creator', zh: '搜索所有创作者的帖子' },
  search_button: { en: 'Search', zh: '搜索' },
  search_order_aria: { en: 'Order results by', zh: '结果排序' },
  search_empty_prompt: {
    en: 'Type something above to search every post in the library.',
    zh: '在上方输入内容，搜索库中的所有帖子。'
  },
  search_nothing: { en: 'Nothing matches "{query}".', zh: '没有与"{query}"匹配的结果。' },

  // ---- Content lists ----
  search_posts: { en: 'Search posts', zh: '搜索帖子' },
  search_products: { en: 'Search products', zh: '搜索商品' },
  search_collections: { en: 'Search collections', zh: '搜索收藏夹' },
  in_collection: { en: ' in collection', zh: '（收藏夹内）' },
  with_query: { en: ' with "{query}"', zh: '，包含"{query}"' },
  tagged_query: { en: ' tagged "{tag}"', zh: '，标签"{tag}"' },
  separator_and: { en: ' and ', zh: '，' },
  no_posts: { en: 'No posts', zh: '暂无帖子' },
  no_products: { en: 'No products', zh: '暂无商品' },
  collection_from: { en: 'Collection from {name}', zh: '来自{name}的收藏夹' },
  posts_count: { en: '{count} posts', zh: '{count} 条帖子' },

  // ---- Post navigation ----
  previous: { en: 'Previous', zh: '上一篇' },
  next: { en: 'Next', zh: '下一篇' },
  comments: { en: 'comments', zh: '条评论' },
  comment: { en: 'comment', zh: '条评论' },
  daily_limit_reached: { en: 'Daily limit reached', zh: '已达今日上限' },

  // ---- Campaign header ----
  header_posts: { en: 'Posts', zh: '帖子' },
  header_collections: { en: 'Collections', zh: '收藏夹' },
  header_shop: { en: 'Shop', zh: '商店' },
  header_media: { en: 'Media', zh: '媒体' },
  header_about: { en: 'About', zh: '关于' },

  // ---- Favorites ----
  fav_remove: { en: 'Remove from favorites', zh: '从收藏中移除' },
  fav_add: { en: 'Add to favorites', zh: '加入收藏' },
  favorites_note: { en: '{count} of {limit} saved.', zh: '已保存 {count}/{limit} 条。' },
  favorites_empty: {
    en: 'No favorites yet. Open a post and tap the star.',
    zh: '还没有收藏。打开帖子并点击星标即可收藏。'
  },
  untitled: { en: 'Untitled', zh: '无标题' },
  col_post: { en: 'Post', zh: '帖子' },
  col_saved: { en: 'Saved', zh: '收藏时间' },
  confirm_remove_question: { en: 'Remove from favorites?', zh: '确定从收藏中移除？' },
  remove: { en: 'Remove', zh: '移除' },
  never_mind: { en: 'Never mind', zh: '取消' },
  could_not_load_favorites: { en: 'Could not load favorites', zh: '无法加载收藏' },
  could_not_update_favorites: { en: 'Could not update favorites', zh: '无法更新收藏' },

  // ---- History ----
  col_video: { en: 'Video', zh: '视频' },
  col_progress: { en: 'Progress', zh: '观看进度' },
  col_watched: { en: 'Watched', zh: '观看时间' },
  col_opened: { en: 'Opened', zh: '浏览时间' },
  history_note: { en: 'The last twenty of each are kept.', zh: '每种仅保留最近 20 条。' },
  history_whose_aria: { en: 'Whose history', zh: '查看谁的记录' },
  you_suffix: { en: ' (you)', zh: '（我）' },
  history_tab_videos: { en: 'Videos ({count})', zh: '视频（{count}）' },
  history_tab_posts: { en: 'Posts ({count})', zh: '帖子（{count}）' },
  history_empty_videos: { en: 'No videos watched yet', zh: '还没有观看记录' },
  history_empty_posts: { en: 'No posts opened yet', zh: '还没有浏览记录' },
  could_not_load_history: { en: 'Could not load history', zh: '无法加载历史记录' },

  // ---- Filters ----
  filters: { en: 'Filters', zh: '筛选' },
  clear: { en: 'Clear', zh: '清除' },
  clear_all: { en: 'Clear all', zh: '全部清除' },
  apply: { en: 'Apply', zh: '应用' },
} satisfies Record<string, TranslationEntry>;