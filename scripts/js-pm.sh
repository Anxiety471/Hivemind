# Shared JS package-manager selection: Bun when available, otherwise npm (Node.js).
# Bun is preferred. Set JS_PM=bun|npm to override.
select_js_pm() {
  if [ -n "${JS_PM:-}" ]; then return 0; fi
  if command -v bun >/dev/null 2>&1; then JS_PM=bun
  elif command -v npm >/dev/null 2>&1; then JS_PM=npm
  else
    echo "missing required tool: bun or npm (install Bun from https://bun.sh, or Node.js)" >&2
    exit 1
  fi
}
