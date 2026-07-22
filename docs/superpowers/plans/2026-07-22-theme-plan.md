# 双皮肤系统 Implementation Plan

**Goal:** Add GitHub Dark + 暖白昼 theme switching via CSS variables + Ant Design algorithm toggle.

**Tasks:**
1. Refactor style.css — replace hardcoded colors with CSS variables, add light theme overrides
2. Update App.tsx — add theme state, persist to localStorage, switch ConfigProvider algorithm
3. Update SettingsMenu — add theme toggle submenu

---

### Task 1: CSS variables + light theme overrides

**Files:** `apps/desktop/ui/src/style.css`

Replace ALL color values with CSS variables. Add `.theme-light` overrides.

Key variable mappings:
- `#0d1117` / `linear-gradient(135deg,#0f0f1a,#1a1a2e,#16213e)` → `var(--bg)`
- `#1c1d21` / `#161b22` → `var(--surface)`
- `#0d0e12` / `#131418` → `var(--input-bg)`
- `rgba(255,255,255,0.85)` → `var(--text)`
- `rgba(255,255,255,0.5)` / `#8d96a0` → `var(--text-muted)`
- `rgba(255,255,255,0.06)` / `#30363d` → `var(--border)`
- `#4fd1c5` → `var(--accent)` (dark) / `#0891b2` (light)
- `#ef4444` → `var(--danger)`
- `#3fb950` / `#6ee7a8` → `var(--success)`

### Task 2: Theme state in App.tsx

Add near top of App component:
```tsx
const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() => {
  return (localStorage.getItem('orion-theme') as 'dark' | 'light') || 'dark'
})
```

Wrap ConfigProvider:
```tsx
<ConfigProvider theme={{
  algorithm: themeMode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
  token: { ...orionTheme.token },
}}>
```

Add `themeMode` class to root shell div: `className={`shell theme-${themeMode}`}`

### Task 3: SettingsMenu theme toggle

Add handler in App.tsx:
```tsx
const handleThemeChange = useCallback((mode: 'dark' | 'light') => {
  setThemeMode(mode)
  localStorage.setItem('orion-theme', mode)
}, [])
```

Update SettingsMenu to include theme toggle with current selection indicator.
