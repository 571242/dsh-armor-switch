/** Maintenance and ordinary-preference editor on this package's detail page. */
window.__ModuleLoader__.load({
  id: 'dsh-armor-switch',
  factory(require) {
    var React = require('react')
    var h = React.createElement
    var NS = 'armor-switch-maintenance'
    var CHANNEL = '/armor-switch'

    function createSource(ctx) {
      var snapshot = { ready: false, busy: false, value: null, message: '', failed: false }
      var listeners = new Set()
      var sequence = 0
      var disposed = false
      function publish(next) {
        if (disposed) return
        snapshot = next
        listeners.forEach(function (listener) { listener() })
      }
      function request(endpoint, payload) {
        if (disposed || snapshot.busy) return Promise.resolve(false)
        var serial = ++sequence
        publish({ ...snapshot, busy: true, message: '', failed: false })
        return Promise.resolve().then(function () {
          var connection = ctx.get('connection')
          if (!connection || !connection.rpc) throw new Error('Connection unavailable')
          return connection.rpc.call(CHANNEL, endpoint, payload || {})
        }).then(function (result) {
          if (serial !== sequence || disposed) return false
          var value = result && result.value
          if (!result || result.ok !== true) {
            publish({ ...snapshot, busy: false, ready: !!value || snapshot.ready,
              value: value || snapshot.value, failed: true,
              message: result && result.error && result.error.code === 'preferences-conflict' ? 'conflict'
                : result && result.error ? result.error.message : 'RPC failed' })
            return false
          }
          publish({ ready: true, busy: false, value: value, failed: false,
            message: endpoint === 'recheck' ? '' : endpoint === 'preferencesSave' ? 'saved' : 'restored' })
          return true
        }).catch(function (error) {
          if (serial !== sequence || disposed) return false
          publish({ ...snapshot, busy: false, failed: true,
            message: error instanceof Error ? error.message : String(error) })
          return false
        })
      }
      return {
        source: {
          getSnapshot: function () { return snapshot },
          subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener) } },
        },
        refresh: function () { return request('recheck') },
        savePreferences: function (text, revision) { return request('preferencesSave', { text: text, expectedRevision: revision }) },
        restore: function (surface) {
          if (!['hostRevert', 'profileRevert', 'revertAll'].includes(surface)) return Promise.resolve(false)
          return request(surface)
        },
        dispose: function () { disposed = true; sequence += 1; listeners.clear() },
      }
    }

    function readableMessage(view, t) {
      return ['saved', 'restored', 'conflict'].includes(view.message) ? t(view.message) : view.message
    }

    function PreferenceEditor(props) {
      var t = props.t
      var draftState = React.useState(props.initial.text)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var dialog = React.useRef(null)
      React.useEffect(function () {
        var element = dialog.current
        if (element && !element.open) element.showModal()
        return function () { if (element && element.open) element.close() }
      }, [])
      function save(event) {
        event.preventDefault()
        props.savePreferences(draft, props.initial.revision).then(function (saved) { if (saved) props.close() })
      }
      return h('dialog', {
        ref: dialog, 'aria-labelledby': 'armor-preferences-title',
        onCancel: function (event) { event.preventDefault(); if (!props.view.busy) props.close() },
        style: { width: 'min(760px, calc(100vw - 48px))', padding: '20px', borderRadius: '12px',
          background: 'var(--dsw-alias-bg-layer-1, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)',
          border: '1px solid var(--dsw-alias-border-l2, GrayText)' },
      }, h('form', { onSubmit: save }, [
        h('h3', { key: 'title', id: 'armor-preferences-title', style: { marginTop: 0 } }, t('editorTitle')),
        h('p', { key: 'scope' }, t('editorScope')),
        h('label', { key: 'label', htmlFor: 'armor-preferences-text' }, t('editorLabel')),
        h('textarea', { key: 'text', id: 'armor-preferences-text', value: draft, maxLength: 10000,
          rows: 12, spellCheck: false, disabled: props.view.busy,
          style: { boxSizing: 'border-box', width: '100%', minHeight: '240px', maxHeight: '60vh',
            marginTop: '8px', padding: '10px', resize: 'vertical', font: 'inherit' },
          onChange: function (event) { setDraft(event.target.value) } }),
        h('p', { key: 'length', style: { fontSize: '12px', opacity: .75 } }, draft.length + ' / 10000'),
        props.view.failed ? h('p', { key: 'error', role: 'alert' }, readableMessage(props.view, t)) : null,
        h('div', { key: 'buttons', style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } }, [
          h('button', { key: 'reset', type: 'button', disabled: props.view.busy, onClick: function () { setDraft('') } }, t('resetPreferences')),
          h('button', { key: 'cancel', type: 'button', disabled: props.view.busy, onClick: props.close }, t('cancel')),
          h('button', { key: 'save', type: 'submit', disabled: props.view.busy || draft.length > 10000 }, props.view.busy ? t('saving') : t('save')),
        ]),
      ]))
    }

    function MaintenancePanel(props) {
      var t = props.t || function (key) { return key }
      var view = props.useMaintenance(function (snapshot) { return snapshot })
      var confirmState = React.useState(null)
      var pending = confirmState[0]
      var setPending = confirmState[1]
      var editorState = React.useState(null)
      var editing = editorState[0]
      var setEditing = editorState[1]
      var status = view.value || {}
      var host = status.hostClean || {}
      var profile = status.profileClean || {}
      var preferences = status.preferences || {}
      var buttonStyle = { marginRight: '8px', padding: '6px 12px', cursor: 'pointer' }
      React.useEffect(function () {
        props.refresh()
        function activate() { props.refresh() }
        function visibility() { if (document.visibilityState === 'visible') activate() }
        window.addEventListener('focus', activate)
        document.addEventListener('visibilitychange', visibility)
        return function () {
          window.removeEventListener('focus', activate)
          document.removeEventListener('visibilitychange', visibility)
        }
      }, [])
      function choose(endpoint) { setPending(endpoint) }
      function button(key, label, action, disabled) {
        return h('button', { key: key, type: 'button', style: buttonStyle,
          disabled: view.busy || disabled, onClick: action }, label)
      }
      var hostLabel = !view.ready ? t('unknown') : !host.ok ? t('problem')
        : host.patched > 0 ? t('modified') + ' (' + host.patched + '/' + host.total + ')' : t('original')
      var profileLabel = !view.ready ? t('unknown') : !profile.ok ? t('problem')
        : profile.present ? t('modified') : t('noBlock')
      return h('section', { style: { padding: '12px 0', lineHeight: 1.7 } }, [
        h('h3', { key: 'title', style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 8px' } }, [
          h('span', { key: 'name' }, t('pluginTitle')),
          h('button', { key: 'edit', type: 'button', title: t('edit'), 'aria-label': t('edit'), 'aria-haspopup': 'dialog',
            disabled: !view.ready || view.busy || preferences.ok !== true,
            style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '18px' },
            onClick: function () { setEditing({ text: preferences.text, revision: preferences.revision }) } }, '✎'),
        ]),
        h('p', { key: 'subtitle' }, t('title')),
        h('p', { key: 'scope' }, t('scope')),
        preferences.ok === false ? h('p', { key: 'preferencesError', role: 'alert' }, preferences.reason) : null,
        h('dl', { key: 'status' }, [
          h('dt', { key: 'hd' }, t('host')), h('dd', { key: 'hv' }, hostLabel),
          h('dt', { key: 'pd' }, t('profile')), h('dd', { key: 'pv' }, profileLabel),
        ]),
        host.asarPath ? h('p', { key: 'hp', style: { overflowWrap: 'anywhere' } }, host.asarPath) : null,
        profile.profileDir ? h('p', { key: 'pp', style: { overflowWrap: 'anywhere' } }, profile.profileDir) : null,
        host.reason || host.restoreWarning ? h('p', { key: 'hw', role: 'status' }, host.reason || host.restoreWarning) : null,
        profile.reason ? h('p', { key: 'pw', role: 'status' }, profile.reason) : null,
        status.restartRequired ? h('p', { key: 'restart', role: 'status' }, t('restart')) : null,
        view.message ? h('p', { key: 'message', role: view.failed ? 'alert' : 'status' }, readableMessage(view, t)) : null,
        h('div', { key: 'actions' }, [
          button('refresh', t('refresh'), props.refresh, false),
          button('rh', t('restoreHost'), function () { choose('hostRevert') }, !view.ready || !host.restorable),
          button('rp', t('restoreProfile'), function () { choose('profileRevert') }, !view.ready || !profile.ok || !profile.present),
          button('ra', t('restoreAll'), function () { choose('revertAll') }, !view.ready || !host.restorable || !profile.ok),
        ]),
        pending ? h('div', { key: 'confirm', role: 'group', 'aria-label': t('confirmTitle') }, [
          h('p', { key: 'note' }, t('confirm')),
          button('yes', t('confirmTitle'), function () { var target = pending; setPending(null); props.restore(target) }, false),
          button('no', t('cancel'), function () { setPending(null) }, false),
        ]) : null,
        editing ? h(PreferenceEditor, { key: 'editor', initial: editing, t: t, view: view,
          savePreferences: props.savePreferences, close: function () { setEditing(null) } }) : null,
      ])
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply: function (ctx) {
        ctx.effect(function () { return ctx.locale.register(NS, {
          zh: {
            pluginTitle: '破甲', edit: '编辑普通角色与交付偏好', editorTitle: '普通偏好编辑器', editorLabel: '角色与交付偏好',
            editorScope: '这里只编辑普通偏好，不查看或覆盖内置指令、破甲覆盖文本或权限规则。保存后用于当前 profile 的后续请求；留空即恢复默认。',
            save: '保存', saving: '保存中…', saved: '普通偏好已保存，将用于后续请求。', resetPreferences: '恢复默认（留空）',
            conflict: '偏好已被其他窗口更新。草稿已保留，请取消后重新打开编辑器，核对最新内容。',
            title: '状态检查与恢复', scope: '仅检查磁盘状态并恢复已有改动；不执行新的清洗或权限提升。原指令文本未修改。',
            host: '宿主归档', profile: '当前 profile', unknown: '尚未确认', problem: '需要检查',
            modified: '存在改动', original: '未检测到改写', noBlock: '无生成覆盖块',
            refresh: '重新检查', restoreHost: '恢复宿主', restoreProfile: '恢复 profile', restoreAll: '恢复两项',
            confirmTitle: '确认恢复', cancel: '取消', confirm: '将按备份恢复宿主原字节，或移除未被编辑的生成覆盖块。操作不会改写当前会话权限；完成后请重启 DSH。',
            restored: '恢复操作完成；请核对上方状态。', restart: '磁盘已写回或写回状态需要确认；请重启 DSH 后验证加载状态。',
          },
          en: {
            pluginTitle: 'Armor', edit: 'Edit ordinary role and delivery preferences', editorTitle: 'Ordinary preferences', editorLabel: 'Role and delivery preferences',
            editorScope: 'Edits ordinary preferences only, not built-in instructions, armor overrides or permission rules. Saved preferences apply to future requests in this profile. Empty text restores defaults.',
            save: 'Save', saving: 'Saving…', saved: 'Ordinary preferences saved for future requests.', resetPreferences: 'Reset to default (empty)',
            conflict: 'Preferences changed in another window. Your draft is retained; close and reopen to review the latest text.',
            title: 'Diagnostics and restoration', scope: 'Inspect disk state and restore existing changes only. No new cleaning or permission escalation. Instruction text is unchanged.',
            host: 'Host archive', profile: 'Current profile', unknown: 'Not confirmed', problem: 'Needs inspection',
            modified: 'Modified', original: 'No rewrite detected', noBlock: 'No generated overrides',
            refresh: 'Recheck', restoreHost: 'Restore host', restoreProfile: 'Restore profile', restoreAll: 'Restore both',
            confirmTitle: 'Confirm restoration', cancel: 'Cancel', confirm: 'Restore recorded original archive bytes or remove an unedited generated override block. Current session permissions are unchanged. Restart DSH afterwards.',
            restored: 'Restoration completed; check the state above.', restart: 'Disk was written or write state is uncertain. Restart DSH and verify loaded state.',
          },
        }) }, 'armor-switch: maintenance dictionary')
        var maintenance = createSource(ctx)
        ctx.effect(function () { return maintenance.dispose }, 'armor-switch: maintenance source')
        ctx.slots.inject('plugins.bundle.config', function () {
          return ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-armor-switch', locale: NS,
            inject: function () { return { hooks: { maintenance: maintenance.source }, refresh: maintenance.refresh,
              restore: maintenance.restore, savePreferences: maintenance.savePreferences } },
          }, MaintenancePanel)
        })
      },
    }
  },
})
