# The install path identifies launchd services and images. Match src/install-slug.ts.
_luna_install_slug() {
  printf '%s' "${LUNA_PROJECT_ROOT:-${PROJECT_ROOT:-$PWD}}" | /usr/bin/shasum -a 1 | /usr/bin/cut -c1-8
}
launchd_label() { printf 'com.luna-%s' "$(_luna_install_slug)"; }
container_image_base() { printf 'luna-agent-%s' "$(_luna_install_slug)"; }
