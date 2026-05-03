// Ambient declarations for third-party modules without first-party types.
// Each is intentionally permissive: we use these via markdown-it's plugin
// API, which already drives the call shape; full typing here would just be
// noise.

declare module "markdown-it-task-lists";
declare module "markdown-it-footnote";
declare module "markdown-it-emoji";
declare module "markdown-it-deflist";
declare module "markdown-it-abbr";
declare module "markdown-it-sub";
declare module "markdown-it-sup";
declare module "markdown-it-ins";
declare module "markdown-it-mark";
declare module "markdown-it-multimd-table";
declare module "markdown-it-container";
declare module "@traptitech/markdown-it-katex";
