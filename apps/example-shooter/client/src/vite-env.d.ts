/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Game server URL. Default: port 6060 on the page's host. */
  readonly VITE_SERVER_URL?: string
}
