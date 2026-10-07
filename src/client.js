/**
 * armor-switch — client half (hand-written `window.__ModuleLoader__` factory).
 *
 * No JSX, no TypeScript, no bundler: this file is loaded verbatim by the page's
 * module table, so it may `require('react')` and nothing else. It registers one
 * composer-dock chip that drives the host half's private RPC channel.
 *
 * Rendered through `conversation.composer.dock` (a LIST slot, so `id` is
 * required). `inject()` returns `{ hooks: { armor }, setArmor, setFullAccess,
 * refresh }`; the renderer turns `hooks.armor` into the component prop
 * `useArmor` (`standardHookPropName` = `use` + capitalized name) and spreads the
 * rest verbatim.
 */
window.__ModuleLoader__.load({
  id: 'dsh-armor-switch',
  factory(require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var RPC_CHANNEL = '/armor-switch'
    var LOCALE_NS = 'armor-switch'
    var STYLE_ID = 'armor-switch-chip-style'

    var CSS = [
      '.armor-chip{display:inline-flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);user-select:none}',
      '.armor-chip__main{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}',
      '.armor-chip__main:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.armor-chip__main[data-on="true"]{color:var(--dsw-alias-label-primary);border-color:rgba(255,120,60,.55);background:rgba(255,120,60,.12)}',
      '.armor-chip__main:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.armor-chip__main:disabled{opacity:.6;cursor:default}',
      '.armor-chip__dot{width:7px;height:7px;flex:none;border-radius:999px;background:var(--dsw-alias-label-tertiary)}',
      '.armor-chip__main[data-on="true"] .armor-chip__dot{background:var(--dsw-alias-state-success-primary)}',
      '.armor-chip__sep{width:1px;height:12px;flex:none;background:var(--dsw-alias-border-l2)}',
      '.armor-chip__full{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 8px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer}',
      '.armor-chip__full:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.armor-chip__full[data-on="true"]{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary));border-color:rgba(230,160,40,.55);background:rgba(230,160,40,.12)}',
      '.armor-chip__full:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.armor-chip__full:disabled{opacity:.6;cursor:default}',
      '.armor-chip__error{color:var(--dsw-alias-state-error-primary);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('')

    /** Inject the chip stylesheet once; the id doubles as the re-evaluation guard. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Human-readable message for a thrown value. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * Build the reactive switch source bound to one plugin context.
     * Implements the `{ getSnapshot(), subscribe(fn) }` contract the renderer's
     * hook binding expects.
     * @param ctx - browser plugin context carrying `connection`.
     */
    function createArmorSource(ctx) {
      var snapshot = {
        enabled: false,
        fullAccess: false,
        contract: '',
        busy: false,
        ready: false,
        message: '',
      }
      var listeners = new Set()

      function publish(next) {
        snapshot = next
        listeners.forEach(function (listener) { listener() })
      }

      function call(endpoint, payload) {
        var connection = ctx.get('connection')
        if (connection === undefined || connection === null) {
          return Promise.reject(new Error('armor-switch: connection service unavailable'))
        }
        return Promise.resolve(connection.rpc.call(RPC_CHANNEL, endpoint, payload || {}))
          .then(function (result) {
            if (!result || result.ok !== true) {
              throw new Error((result && result.error && result.error.message) || 'armor-switch: rpc failed')
            }
            return result.value
          })
      }

      function adopt(value, extra) {
        publish({
          enabled: value && value.enabled === true,
          fullAccess: value && value.fullAccess === true,
          contract: (value && value.contract) || snapshot.contract,
          busy: false,
          ready: true,
          message: (extra && extra.message) || '',
        })
      }

      /** Local optimistic flip, then calibrate from the host's answer. */
      function setArmor(enabled) {
        publish({ ...snapshot, enabled: enabled, busy: true, message: '' })
        return call('set', { enabled: enabled })
          .then(function (value) { adopt(value) })
          .catch(function (error) {
            publish({ ...snapshot, busy: false, ready: false, message: messageOf(error) })
          })
      }

      function toggle() {
        return setArmor(!snapshot.enabled)
      }

      function setFullAccess(fullAccess) {
        publish({ ...snapshot, fullAccess: fullAccess, busy: true, message: '' })
        return call('set', { fullAccess: fullAccess })
          .then(function (value) {
            var note = value && Array.isArray(value.sources)
              ? value.sources.filter(function (s) { return String(s).indexOf('fullAccess:') === 0 }).join('; ')
              : ''
            adopt(value, { message: note })
          })
          .catch(function (error) {
            publish({ ...snapshot, busy: false, ready: false, message: messageOf(error) })
          })
      }

      function refresh() {
        return call('recheck', {})
          .then(function (value) { adopt(value) })
          .catch(function (error) {
            publish({ ...snapshot, ready: false, message: messageOf(error) })
          })
      }

      return {
        source: {
          getSnapshot: function () { return snapshot },
          subscribe: function (listener) {
            listeners.add(listener)
            return function () { listeners.delete(listener) }
          },
        },
        setArmor: setArmor,
        setFullAccess: setFullAccess,
        refresh: refresh,
        toggle: toggle,
      }
    }

    /**
     * The composer-dock chip: a main dot+label toggle plus a small full-access
     * secondary toggle. Text comes from the locale seat (`props.t`).
     * @param props - locale `t`, the `useArmor` selector hook, and the actions.
     */
    function ArmorChip(props) {
      var t = props.t || function (key) { return key }
      var view = props.useArmor(function (snapshot) { return snapshot })
      var enabled = view.enabled === true
      var fullAccess = view.fullAccess === true
      var busy = view.busy === true
      var title = enabled ? t('chipTitleOn') : t('chipTitleOff')
      var fullTitle = fullAccess ? t('fullAccessTitleOn') : t('fullAccessTitleOff')

      var children = [
        h('button', {
          key: 'main',
          type: 'button',
          className: 'armor-chip__main',
          'data-on': enabled ? 'true' : 'false',
          title: title,
          'aria-label': title,
          'aria-pressed': enabled ? 'true' : 'false',
          disabled: busy,
          onClick: function () { props.setArmor(!enabled) },
        }, [
          h('span', { key: 'dot', className: 'armor-chip__dot', 'aria-hidden': 'true' }),
          h('span', { key: 'label' }, enabled ? t('chipOn') : t('chipOff')),
        ]),
        h('span', { key: 'sep', className: 'armor-chip__sep', 'aria-hidden': 'true' }),
        h('button', {
          key: 'full',
          type: 'button',
          className: 'armor-chip__full',
          'data-on': fullAccess ? 'true' : 'false',
          title: fullTitle,
          'aria-label': fullTitle,
          'aria-pressed': fullAccess ? 'true' : 'false',
          disabled: busy,
          onClick: function () { props.setFullAccess(!fullAccess) },
        }, fullAccess ? t('fullAccessOn') : t('fullAccessOff')),
      ]

      if (view.ready === false && view.message) {
        children.push(h('span', {
          key: 'err',
          className: 'armor-chip__error',
          title: view.message,
        }, view.message))
      }

      // Refresh once on mount so a reload shows the host's live truth rather
      // than this source's initial defaults.
      useEffect(function () { props.refresh() }, [])

      return h('span', {
        className: 'armor-chip',
        'data-contract': view.contract || '',
        title: view.contract ? t('contractLabel') + ': ' + view.contract : undefined,
      }, children)
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply: function apply(ctx) {
        ctx.effect(function () {
          ensureStyles()
          return function () {
            if (typeof document === 'undefined') return
            var tag = document.getElementById(STYLE_ID)
            if (tag !== null && tag.parentNode) tag.parentNode.removeChild(tag)
          }
        }, 'armor-switch: chip styles')

        ctx.effect(function () {
          return ctx.locale.register(LOCALE_NS, {
            zh: {
              meta: { title: '破甲开关', description: '一键开关的交付契约插件。' },
              chipOn: '破甲 开', chipOff: '破甲 关',
              chipTitleOn: '破甲已开启。点击关闭，下一次请求即恢复官方提示词。',
              chipTitleOff: '破甲已关闭（与官方逐字节一致）。点击开启，下一次请求即生效。',
              fullAccessOn: '全权', fullAccessOff: '全权',
              fullAccessTitleOn: '全权已开启：沙箱 danger-full-access、审批 never。点击恢复该 profile 配置的默认预设。',
              fullAccessTitleOff: '全权已关闭（已恢复该 profile 的默认预设）。点击切到 danger-full-access + 审批 never。',
              contractLabel: '契约',
            },
            en: {
              meta: { title: 'Armor switch', description: 'One-click delivery-contract toggle.' },
              chipOn: 'Armor on', chipOff: 'Armor off',
              chipTitleOn: 'Armor is on. Click to switch off; the next request reverts to stock.',
              chipTitleOff: 'Armor is off (byte-identical to stock). Click to switch on.',
              fullAccessOn: 'Full', fullAccessOff: 'Full',
              fullAccessTitleOn: 'Full access on: danger-full-access, approval never. Click to restore this profile\'s default preset.',
              fullAccessTitleOff: 'Full access off (this profile\'s default preset is restored). Click for danger-full-access with approval never.',
              contractLabel: 'contract',
            },
          })
        }, 'armor-switch: chip dictionary')

        var armor = createArmorSource(ctx)

        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'armor-switch',
            order: 50,
            locale: LOCALE_NS,
            inject: function () {
              return {
                hooks: { armor: armor.source },
                setArmor: armor.setArmor,
                setFullAccess: armor.setFullAccess,
                refresh: armor.refresh,
              }
            },
          }, ArmorChip)
        })
      },
    }
  },
})
