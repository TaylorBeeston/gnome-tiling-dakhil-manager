import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {SelectArea} from 'resource:///org/gnome/shell/ui/screenshot.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
const reloadIndex = import.meta.url.indexOf('?');
const reloadSuffix = reloadIndex < 0 ? '' : import.meta.url.slice(reloadIndex);
console.log(`[Dwindle] Importing runtime ${reloadSuffix || 'without reload token'}`);
const {flipTransform, geometryChanged} =
    await import(`./animationMath.js${reloadSuffix}`);
const {PrimarySystemBar, SecondarySystemBar} =
    await import(`./secondaryWorkspacePanel.js${reloadSuffix}`);
const {
    actualWorkspaceForLocal,
    modulo,
    parseTreeKey,
    shiftedOffset,
    shiftTreeKeyForConnector,
    treeKey,
} = await import(`./workspaceMath.js${reloadSuffix}`);

const MIN_WORKSPACES = 1;
const MAX_WORKSPACES = 10;
const NATIVE_WM_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const NATIVE_SHELL_SCHEMA = 'org.gnome.shell.keybindings';
const NATIVE_PREFS_SCHEMA = 'org.gnome.desktop.wm.preferences';
const SECONDARY_PANEL_CONNECTORS = new Set(['Meta-0']);
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.gnome.Mutter.DisplayConfig">
    <method name="GetCurrentState">
      <arg name="serial" direction="out" type="u"/>
      <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})"/>
      <arg name="logicalMonitors" direction="out" type="a(iiduba(ssss)a{sv})"/>
      <arg name="properties" direction="out" type="a{sv}"/>
    </method>
  </interface>
</node>`);

const NATIVE_MUTTER_SCHEMA = 'org.gnome.mutter';
function laterAdd(type, callback) {
    return global.compositor.get_laters().add(type, callback);
}

function laterRemove(sourceId) {
    global.compositor.get_laters().remove(sourceId);
}


export default class TilingExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._keybindings = [];
        this._windowSignals = new Map();
        this._floatingWindows = new Set();
        this._trees = new Map();
        this._lastFocusedTileable = null;
        this._pendingFirstFrame = new Set();
        this._monocleWin = null;
        this._monocleHidden = null;
        this._monocleButton = null;
        this._monocleBorder = null;
        this._monocleGeomSignals = null;
        this._floatNextWindow = false;
        this._floatNextButton = null;
        this._retileQueued = false;
        this._retileSourceId = 0;
        this._managedWorkspaceMoves = new Set();
        this._managedMonitorMoves = new Set();
        this._workspaceCount = Math.max(MIN_WORKSPACES,
            Math.min(MAX_WORKSPACES, this._settings.get_int('workspace-count')));
        this._monitorWorkspaceOffsets = this._loadMonitorWorkspaceOffsets();
        this._monitorConnectors = new Map();
        this._secondaryWorkspacePanels = new Map();
        this._primarySystemBar = null;
        this._lastFocusedWindowTitle = '';
        this._screenshotInProgress = false;
        this._screenshotSelector = null;
        this._displayConfigProxy = new DisplayConfigProxy(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            (proxy, error) => {
                if (error) {
                    console.error(`[Dwindle] Cannot read monitor connectors: ${error}`);
                    return;
                }

                if (proxy === this._displayConfigProxy)
                    this._refreshMonitorConnectors();
            }
        );

        this._animationsReady = false;
        this._animationReadySourceId = 0;
        this._pendingWindowAnimations = new Map();
        this._workspaceAnimationSources = new Set();
        this._animatedActors = new Set();
        this._workspaceCloneContainers = new Set();
        this._workspaceSwitching = false;
        this._animationDisabledClasses = new Set(
            this._settings.get_strv('animation-disabled-classes')
                .map(value => value.toLowerCase())
        );

        this._installWorkspaceCount();
        this._installNativeWorkspaceBindings();
        this._installNativeWindowOverrides();
        this._installNativeScreenshotBinding();
        this._installFocusFollowsMouse();
        this._installPanelLayout();

        for (let i = 1; i <= this._workspaceCount; i++) {
            this._addKeybinding(
                `switch-local-workspace-${i}`,
                () => this._switchLocalWorkspace(i - 1)
            );
            this._addKeybinding(
                `move-window-to-workspace-${i}`,
                () => this._moveWindowToWorkspace(i - 1)
            );
        }
        this._addKeybinding('toggle-tiling', () => this._toggleTiling());
        this._addKeybinding('toggle-floating', () => this._toggleFloating());
        this._addKeybinding('float-next-window', () => this._armFloatNext());
        this._addKeybinding('focus-left', () => this._focusDirection('left'));
        this._addKeybinding('focus-right', () => this._focusDirection('right'));
        this._addKeybinding('focus-up', () => this._focusDirection('up'));
        this._addKeybinding('focus-down', () => this._focusDirection('down'));
        this._addKeybinding('show-focused-info', () => this._showFocusedInfo());
        this._addKeybinding('close-window', () => this._closeFocusedWindow());
        this._addKeybinding('toggle-decoration', () => this._toggleDecoration());
        this._addKeybinding('show-help', () => this._toggleHelp());
        this._addKeybinding('resize-left', () => this._resize('left'));
        this._addKeybinding('resize-right', () => this._resize('right'));
        this._addKeybinding('resize-up', () => this._resize('up'));
        this._addKeybinding('resize-down', () => this._resize('down'));
        this._addKeybinding('rotate-split', () => this._toggleSplitOrientation());
        this._addKeybinding('move-window-left', () => this._moveWindow('left'));
        this._addKeybinding('move-window-right', () => this._moveWindow('right'));
        this._addKeybinding('move-window-up', () => this._moveWindow('up'));
        this._addKeybinding('move-window-down', () => this._moveWindow('down'));
        this._addKeybinding('window-to-monitor-left', () => this._moveToMonitor('left'));
        this._addKeybinding('window-to-monitor-right', () => this._moveToMonitor('right'));
        this._addKeybinding('window-to-monitor-up', () => this._moveToMonitor('up'));
        this._addKeybinding('window-to-monitor-down', () => this._moveToMonitor('down'));
        this._addKeybinding('toggle-monocle', () => this._toggleMonocle());
        this._addKeybinding('open-terminal', () => this._openTerminal());
        this._addKeybinding('screenshot-region', () => this._captureRegionScreenshot());

        this._gapChangedId = this._settings.connect('changed::gap-size',
            () => this._retileAll());
        this._enabledChangedId = this._settings.connect('changed::tiling-enabled',
            () => this._retileAll());
        this._floatClassChangedId = this._settings.connect('changed::floating-window-classes', () => {
            this._reapplyFloatingClasses();
            this._retileAll();
        });
        this._animationClassChangedId = this._settings.connect(
            'changed::animation-disabled-classes',
            () => {
                this._animationDisabledClasses = new Set(
                    this._settings.get_strv('animation-disabled-classes')
                        .map(value => value.toLowerCase())
                );
            }
        );
        this._countChangedId = this._settings.connect('changed::workspace-count', () => {
            const newCount = this._settings.get_int('workspace-count');
            if (this._wmPrefsSettings)
                this._wmPrefsSettings.set_int('num-workspaces', newCount);
            this._workspaceCount = newCount;
            this._normalizeMonitorWorkspaceOffsets();
            this._refreshSystemBars();
            Main.notify('Dwindle',
                `Workspaces: ${newCount}. Disable and re-enable the extension to refresh Super+N bindings.`);
        });
        this._panelChangedIds = [
            this._settings.connect('changed::panel-spacing',
                () => this._applyPanelSpacing()),
            this._settings.connect('changed::panel-show-focused-app',
                () => this._updateSystemBars()),
        ];

        this._windowCreatedId = global.display.connect('window-created',
            (_d, win) => this._onWindowCreated(win));
        this._switchWsId = global.window_manager.connect('switch-workspace',
            (_wm, from, to) => this._onWorkspaceSwitch(from, to));
        this._grabOpEndId = global.display.connect('grab-op-end',
            (_d, win) => this._onGrabOpEnd(win));
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this._onMonitorsChanged());

        this._installFocusBorder();

        for (const win of global.display.list_all_windows())
            this._handleExistingOrNewWindow(win);

        this._retileAll();
        this._animationReadySourceId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._animationsReady = true;
                this._animationReadySourceId = 0;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    disable() {
        if (this._helpDialog) {
            try { this._helpDialog.close(); } catch (_e) {}
            this._helpDialog = null;
        }
        this._exitMonocle();
        this._floatNextWindow = false;
        this._hideFloatNextIndicator();
        this._uninstallFocusBorder();
        this._destroySecondaryWorkspacePanels();
        this._uninstallPanelLayout();
        this._uninstallFocusFollowsMouse();
        this._uninstallNativeWindowOverrides();
        this._uninstallNativeScreenshotBinding();
        this._uninstallNativeWorkspaceBindings();
        this._uninstallWorkspaceCount();

        for (const name of (this._keybindings || []))
            Main.wm.removeKeybinding(name);
        this._keybindings = null;

        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = null;
        }
        if (this._switchWsId) {
            global.window_manager.disconnect(this._switchWsId);
            this._switchWsId = null;
        }
        if (this._grabOpEndId) {
            global.display.disconnect(this._grabOpEndId);
            this._grabOpEndId = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._settings) {
            if (this._gapChangedId) this._settings.disconnect(this._gapChangedId);
            if (this._enabledChangedId) this._settings.disconnect(this._enabledChangedId);
            if (this._floatClassChangedId) this._settings.disconnect(this._floatClassChangedId);
            if (this._countChangedId) this._settings.disconnect(this._countChangedId);
            if (this._animationClassChangedId)
                this._settings.disconnect(this._animationClassChangedId);
            if (this._panelChangedIds) {
                for (const id of this._panelChangedIds) {
                    try { this._settings.disconnect(id); } catch (_e) {}
                }
            }
        }
        this._gapChangedId = null;
        this._enabledChangedId = null;
        this._floatClassChangedId = null;
        this._countChangedId = null;
        this._animationClassChangedId = null;
        this._panelChangedIds = null;

        if (this._pendingFirstFrame) {
            for (const {actor, id} of this._pendingFirstFrame) {
                try { actor.disconnect(id); } catch (_e) {}
            }
            this._pendingFirstFrame.clear();
        }
        this._pendingFirstFrame = null;

        if (this._retileSourceId) {
            GLib.source_remove(this._retileSourceId);
            this._retileSourceId = 0;
        }
        this._retileQueued = false;
        this._cleanupAnimations();

        if (this._floatingWindows) this._floatingWindows.clear();
        this._floatingWindows = null;
        if (this._trees) this._trees.clear();
        this._trees = null;
        this._lastFocusedTileable = null;
        if (this._managedWorkspaceMoves) this._managedWorkspaceMoves.clear();
        this._managedWorkspaceMoves = null;
        if (this._managedMonitorMoves) this._managedMonitorMoves.clear();
        this._managedMonitorMoves = null;
        this._monitorWorkspaceOffsets = null;
        this._displayConfigProxy = null;
        this._monitorConnectors = null;
        this._secondaryWorkspacePanels = null;
        this._primarySystemBar = null;
        this._lastFocusedWindowTitle = null;
        this._screenshotSelector = null;
        this._screenshotInProgress = false;
        this._animationDisabledClasses = null;

        if (this._windowSignals) {
            for (const [win, ids] of this._windowSignals) {
                for (const id of ids) {
                    try { win.disconnect(id); } catch (_e) {}
                }
            }
            this._windowSignals.clear();
        }
        this._windowSignals = null;
        this._settings = null;
    }

    _addKeybinding(name, handler) {
        Main.wm.addKeybinding(
            name,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            handler
        );
        this._keybindings.push(name);
    }
    _installNativeScreenshotBinding() {
        if (!this._shellSettings) return;

        this._savedScreenshotUiBinding =
            this._shellSettings.get_strv('show-screenshot-ui');
        this._shellSettings.set_strv('show-screenshot-ui', []);
    }

    _uninstallNativeScreenshotBinding() {
        if (this._shellSettings && this._savedScreenshotUiBinding)
            this._shellSettings.set_strv(
                'show-screenshot-ui',
                this._savedScreenshotUiBinding
            );

        this._savedScreenshotUiBinding = null;
    }

    async _captureRegionScreenshot() {
        if (this._screenshotInProgress) return;

        this._screenshotInProgress = true;

        let area;

        try {
            this._screenshotSelector = new SelectArea();
            area = await this._screenshotSelector.selectAsync();
        } catch (_error) {
            return;
        } finally {
            this._screenshotSelector = null;
            this._screenshotInProgress = false;
        }

        const file = Gio.File.new_for_path(
            `${GLib.get_tmp_dir()}/dwindle-screenshot-${GLib.get_real_time()}.png`
        );
        const stream = file.replace(
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );

        try {
            const screenshot = new Shell.Screenshot();

            await screenshot.screenshot_area(
                Math.round(area.x),
                Math.round(area.y),
                Math.max(1, Math.round(area.width)),
                Math.max(1, Math.round(area.height)),
                stream
            );
            stream.close(null);

            const process = Gio.Subprocess.new(
                ['swappy', '-f', file.get_path()],
                Gio.SubprocessFlags.NONE
            );

            process.wait_async(null, (_process, result) => {
                try { process.wait_finish(result); } catch (_error) {}
                file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
            });
        } catch (error) {
            try { stream.close(null); } catch (_closeError) {}
            try { file.delete(null); } catch (_deleteError) {}
            console.error(`[Dwindle] Region screenshot failed: ${error}`);
            Main.notify('Dwindle', 'Could not open the screenshot in Swappy');
        }
    }


    _installWorkspaceCount() {
        this._wmPrefsSettings = new Gio.Settings({schema_id: NATIVE_PREFS_SCHEMA});
        this._mutterSettings = new Gio.Settings({schema_id: NATIVE_MUTTER_SCHEMA});
        this._savedNumWorkspaces = this._wmPrefsSettings.get_int('num-workspaces');
        this._savedDynamicWorkspaces = this._mutterSettings.get_boolean('dynamic-workspaces');
        this._mutterSettings.set_boolean('dynamic-workspaces', false);
        this._wmPrefsSettings.set_int('num-workspaces', this._workspaceCount);
    }

    _uninstallWorkspaceCount() {
        if (this._wmPrefsSettings && this._savedNumWorkspaces !== null && this._savedNumWorkspaces !== undefined)
            this._wmPrefsSettings.set_int('num-workspaces', this._savedNumWorkspaces);
        if (this._mutterSettings && this._savedDynamicWorkspaces !== null && this._savedDynamicWorkspaces !== undefined)
            this._mutterSettings.set_boolean('dynamic-workspaces', this._savedDynamicWorkspaces);
        this._wmPrefsSettings = null;
        this._mutterSettings = null;
        this._savedNumWorkspaces = null;
        this._savedDynamicWorkspaces = null;
    }

    _installNativeWorkspaceBindings() {
        this._wmSettings = new Gio.Settings({schema_id: NATIVE_WM_SCHEMA});
        this._shellSettings = new Gio.Settings({schema_id: NATIVE_SHELL_SCHEMA});
        this._savedNativeBindings = {};

        for (let i = 1; i <= this._workspaceCount; i++) {
            const wsKey = `switch-to-workspace-${i}`;
            const appKey = i <= 9 ? `switch-to-application-${i}` : null;

            this._savedNativeBindings[wsKey] = this._wmSettings.get_strv(wsKey);

            if (appKey) {
                this._savedNativeBindings[appKey] = this._shellSettings.get_strv(appKey);
                this._shellSettings.set_strv(appKey, []);
            }

            this._wmSettings.set_strv(wsKey, []);
        }
    }

    _uninstallNativeWorkspaceBindings() {
        if (!this._savedNativeBindings) return;
        for (const [key, value] of Object.entries(this._savedNativeBindings)) {
            const settings = key.startsWith('switch-to-application')
                ? this._shellSettings : this._wmSettings;
            if (settings)
                settings.set_strv(key, value);
        }
        this._savedNativeBindings = null;
        this._wmSettings = null;
        this._shellSettings = null;
    }

    _overrideNative(schemaId, key, type, newValue) {
        let settings;
        try {
            settings = new Gio.Settings({schema_id: schemaId});
        } catch (_e) {
            console.warn(`[tiling] schema ${schemaId} no disponible, salto ${key}`);
            return;
        }
        const oldValue = type === 'bool'
            ? settings.get_boolean(key)
            : settings.get_strv(key);
        this._savedNativeOverrides.push({settings, key, type, value: oldValue});
        if (type === 'bool') settings.set_boolean(key, newValue);
        else settings.set_strv(key, newValue);
    }

    _installNativeWindowOverrides() {
        if (!this._settings.get_boolean('disable-native-window-management')) return;
        this._savedNativeOverrides = [];

        this._overrideNative('org.gnome.mutter', 'edge-tiling', 'bool', false);
        this._overrideNative('org.gnome.mutter', 'auto-maximize', 'bool', false);
        this._overrideNative('org.gnome.desktop.wm.keybindings', 'maximize', 'strv', []);
        this._overrideNative('org.gnome.desktop.wm.keybindings', 'unmaximize', 'strv', []);
        this._overrideNative('org.gnome.mutter.keybindings', 'toggle-tiled-left', 'strv', []);
        this._overrideNative('org.gnome.mutter.keybindings', 'toggle-tiled-right', 'strv', []);
        this._overrideNative('org.gnome.desktop.wm.keybindings', 'move-to-workspace-up', 'strv', []);
        this._overrideNative('org.gnome.desktop.wm.keybindings', 'move-to-workspace-down', 'strv', []);
        this._overrideNative('org.gnome.desktop.wm.keybindings', 'move-to-workspace-left', 'strv', []);
        this._overrideNative('org.gnome.desktop.wm.keybindings', 'move-to-workspace-right', 'strv', []);
        this._overrideNative('org.gnome.desktop.wm.keybindings', 'move-to-monitor-up', 'strv', []);
        this._overrideNative('org.gnome.desktop.wm.keybindings', 'move-to-monitor-down', 'strv', []);
        this._overrideNative('org.gnome.desktop.wm.keybindings', 'move-to-monitor-left', 'strv', []);
        this._overrideNative('org.gnome.desktop.wm.keybindings', 'move-to-monitor-right', 'strv', []);
        this._overrideNative('org.gnome.settings-daemon.plugins.media-keys', 'help', 'strv', ['']);
    }

    _uninstallNativeWindowOverrides() {
        if (!this._savedNativeOverrides) return;
        for (const o of this._savedNativeOverrides.reverse()) {
            if (o.type === 'bool') o.settings.set_boolean(o.key, o.value);
            else o.settings.set_strv(o.key, o.value);
        }
        this._savedNativeOverrides = null;
    }

    // "El foco sigue al raton": escribe el focus-mode nativo de GNOME a
    // 'sloppy' (la ventana bajo el puntero recibe el foco sin clic, pero
    // pasar por el escritorio vacio mantiene el ultimo foco). Guardamos el
    // valor original del usuario para restaurarlo al desactivar el ajuste o
    // la extension. Reacciona en caliente al cambiar el toggle en prefs.
    _installFocusFollowsMouse() {
        try {
            this._ffmSettings = new Gio.Settings({schema_id: NATIVE_PREFS_SCHEMA});
        } catch (_e) {
            this._ffmSettings = null;
            return;
        }
        this._savedFocusMode = this._ffmSettings.get_string('focus-mode');
        this._applyFocusFollowsMouse();
        this._ffmChangedId = this._settings.connect('changed::focus-follows-mouse',
            () => this._applyFocusFollowsMouse());
    }

    _applyFocusFollowsMouse() {
        if (!this._ffmSettings || !this._settings) return;
        if (this._settings.get_boolean('focus-follows-mouse'))
            this._ffmSettings.set_string('focus-mode', 'sloppy');
        else
            this._ffmSettings.set_string('focus-mode', this._savedFocusMode || 'click');
    }

    _uninstallFocusFollowsMouse() {
        if (this._ffmChangedId && this._settings) {
            try { this._settings.disconnect(this._ffmChangedId); } catch (_e) {}
        }
        this._ffmChangedId = null;
        if (this._ffmSettings && this._savedFocusMode !== null
            && this._savedFocusMode !== undefined)
            this._ffmSettings.set_string('focus-mode', this._savedFocusMode);
        this._ffmSettings = null;
        this._savedFocusMode = null;
    }

    _installPanelLayout() {
        this._panelBoxOrigStyle = null;
        this._installPrimarySystemBar();
        this._applyPanelSpacing();
    }

    _uninstallPanelLayout() {
        this._destroyPrimarySystemBar();
        this._restorePanelSpacing();
    }

    _installPrimarySystemBar() {
        if (this._primarySystemBar || !this._settings) return;

        this._primarySystemBar = new PrimarySystemBar(
            this._workspaceCount,
            localIndex => this._switchLocalWorkspace(
                localIndex,
                null,
                Main.layoutManager.primaryIndex
            ),
            this._settings.get_int('panel-spacing')
        );
        this._updateSystemBars();
    }

    _destroyPrimarySystemBar() {
        if (!this._primarySystemBar) return;

        this._primarySystemBar.destroy();
        this._primarySystemBar = null;
    }

    _focusedWindowTitle() {
        const win = global.display.focus_window;

        if (!win) return this._lastFocusedWindowTitle || '';

        const tracker = Shell.WindowTracker.get_default();
        const appName = tracker.get_window_app(win)?.get_name() || '';
        const title = win.get_title() || '';
        let text = title && appName
            && !title.toLowerCase().includes(appName.toLowerCase())
            ? `${appName} — ${title}`
            : title || appName || win.get_wm_class() || '';

        if (text.length > 80) text = `${text.slice(0, 79)}…`;

        this._lastFocusedWindowTitle = text;
        return text;
    }

    _panelBoxes() {
        return [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
    }

    _applyPanelSpacing() {
        const px = this._settings.get_int('panel-spacing');
        const boxes = this._panelBoxes();
        if (!this._panelBoxOrigStyle)
            this._panelBoxOrigStyle = boxes.map(b => b.get_style());
        boxes.forEach((b, i) => {
            const base = this._panelBoxOrigStyle[i] || '';
            if (px < 0) b.set_style(this._panelBoxOrigStyle[i]);
            else b.set_style(`${base} spacing: ${px}px;`);
        });
        this._primarySystemBar?.setSpacing(px);

        for (const {panel} of this._secondaryWorkspacePanels?.values() || [])
            panel.setSpacing(px);
    }

    _restorePanelSpacing() {
        if (!this._panelBoxOrigStyle) return;
        const boxes = this._panelBoxes();
        boxes.forEach((b, i) => b.set_style(this._panelBoxOrigStyle[i]));
        this._panelBoxOrigStyle = null;
    }

    _installFocusBorder() {
        this._focusBorder = new St.Widget({
            reactive: false,
            can_focus: false,
            visible: false,
        });
        global.window_group.add_child(this._focusBorder);
        this._focusGeomSignals = [];

        this._updateFocusBorderStyle();

        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            this._trackFocusedTileable();
            this._updateFocusBorder();
            this._updateSystemBars();
            this._updateMonocleVisuals();
        });
        this._borderEnabledId = this._settings.connect('changed::focus-border-enabled',
            () => this._updateFocusBorder());
        this._borderWidthId = this._settings.connect('changed::focus-border-width', () => {
            this._updateFocusBorderStyle();
            this._updateFocusBorder();
            this._updateMonocleBorderStyle();
            this._updateMonocleVisuals();
        });
        this._borderColorId = this._settings.connect('changed::focus-border-color', () => {
            this._updateFocusBorderStyle();
            this._updateMonocleBorderStyle();
        });

        this._overviewShowingId = Main.overview.connect('showing',
            () => { if (this._focusBorder) this._focusBorder.hide(); this._hideMonocleBorder(); });
        this._overviewHiddenId = Main.overview.connect('hidden',
            () => { this._updateFocusBorder(); this._updateMonocleVisuals(); });

        this._updateFocusBorder();
    }

    _uninstallFocusBorder() {
        if (this._focusGeomSignals) {
            for (const {win, id} of this._focusGeomSignals) {
                try { win.disconnect(id); } catch (_e) {}
            }
            this._focusGeomSignals = null;
        }
        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = null;
        }
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }
        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = null;
        }
        if (this._settings) {
            if (this._borderEnabledId) this._settings.disconnect(this._borderEnabledId);
            if (this._borderWidthId) this._settings.disconnect(this._borderWidthId);
            if (this._borderColorId) this._settings.disconnect(this._borderColorId);
        }
        this._borderEnabledId = null;
        this._borderWidthId = null;
        this._borderColorId = null;
        if (this._focusBorder) {
            const parent = this._focusBorder.get_parent();
            if (parent) parent.remove_child(this._focusBorder);
            this._focusBorder.destroy();
            this._focusBorder = null;
        }
    }

    _updateFocusBorderStyle() {
        if (!this._focusBorder || !this._settings) return;
        const color = this._settings.get_string('focus-border-color');
        const width = this._settings.get_int('focus-border-width');
        this._focusBorder.set_style(
            `border: ${width}px solid ${color};` +
            `background-color: transparent;`
        );
    }

    _updateFocusBorder() {
        if (!this._focusBorder) return;

        if (this._focusGeomSignals) {
            for (const {win: w, id} of this._focusGeomSignals) {
                try { w.disconnect(id); } catch (_e) {}
            }
            this._focusGeomSignals = [];
        }

        const win = global.display.focus_window;
        const enabled = this._settings && this._settings.get_boolean('focus-border-enabled');

        if (!enabled || !win || win.fullscreen || win.minimized
            || Main.overview.visible
            || win.get_window_type() !== Meta.WindowType.NORMAL) {
            this._focusBorder.hide();
            return;
        }

        this._positionFocusBorder(win);
        this._focusBorder.show();

        const posId = win.connect('position-changed', () => this._positionFocusBorder(win));
        const sizeId = win.connect('size-changed', () => this._positionFocusBorder(win));
        const fsId = win.connect('notify::fullscreen', () => this._updateFocusBorder());
        this._focusGeomSignals.push({win, id: posId});
        this._focusGeomSignals.push({win, id: sizeId});
        this._focusGeomSignals.push({win, id: fsId});
    }

    _positionFocusBorder(win) {
        if (!this._focusBorder || !win || !this._settings) return;
        const rect = win.get_frame_rect();
        const w = this._settings.get_int('focus-border-width');
        // El borde se dibuja en un anillo de w px POR FUERA del marco (queda en
        // el gap). Si la ventana toca el borde del monitor (gap=0, o pegada al
        // borde), ese anillo caeria fuera y se veria en los monitores vecinos.
        // Recortamos la caja a la geometria del monitor para que nunca se
        // desborde.
        let x = rect.x - w;
        let y = rect.y - w;
        let right = rect.x + rect.width + w;
        let bottom = rect.y + rect.height + w;
        const mon = global.display.get_monitor_geometry(win.get_monitor());
        if (mon) {
            x = Math.max(x, mon.x);
            y = Math.max(y, mon.y);
            right = Math.min(right, mon.x + mon.width);
            bottom = Math.min(bottom, mon.y + mon.height);
        }
        this._focusBorder.set_position(x, y);
        this._focusBorder.set_size(Math.max(0, right - x), Math.max(0, bottom - y));
        // Colocar el borde justo ENCIMA del actor de la ventana con foco, no
        // en el tope del window_group. Si lo subimos al tope (sibling null), el
        // borde de una ventana tiled tapa a una flotante apilada por encima de
        // ella. Anclandolo sobre su propia ventana, el borde queda visible
        // sobre ella pero por debajo de las ventanas mas altas (flotantes,
        // always-on-top), que es lo correcto.
        const parent = this._focusBorder.get_parent();
        if (!parent || !parent.set_child_above_sibling) return;
        const actor = win.get_compositor_private();
        if (actor && actor.get_parent() === parent)
            parent.set_child_above_sibling(this._focusBorder, actor);
        else
            parent.set_child_above_sibling(this._focusBorder, null);
    }

    _moveWindowToWorkspace(localIndex) {
        const win = global.display.focus_window;
        if (!win) return;

        if (!this._settings.get_boolean('monitor-local-workspaces')) {
            const target = global.workspace_manager.get_workspace_by_index(localIndex);
            if (!target) return;

            win.change_workspace(target);
            return;
        }

        const monitor = win.get_monitor();
        const targetIndex = this._actualWorkspaceForLocal(monitor, localIndex);
        const target = global.workspace_manager.get_workspace_by_index(targetIndex);
        if (!target) return;

        if (win.get_workspace() !== target)
            win.change_workspace(target);

    }

    _switchLocalWorkspace(localIndex, focusWindow = null, monitorOverride = null) {
        const monitor = monitorOverride
            ?? focusWindow?.get_monitor()
            ?? this._activeMonitor();

        if (!this._settings.get_boolean('monitor-local-workspaces')) {
            const target = global.workspace_manager.get_workspace_by_index(localIndex);
            if (!target) return;

            target.activate(global.get_current_time());
            return;
        }

        const activeIndex = global.workspace_manager.get_active_workspace_index();
        const targetIndex = this._actualWorkspaceForLocal(monitor, localIndex);
        if (targetIndex === activeIndex) {
            focusWindow?.activate(global.get_current_time());
            return;
        }

        const target = global.workspace_manager.get_workspace_by_index(targetIndex);
        const candidate = focusWindow ?? target?.list_windows().find(win =>
            win.get_monitor() === monitor
            && !win.minimized
            && win.get_window_type() === Meta.WindowType.NORMAL
        );
        const currentLocal = modulo(
            activeIndex - this._monitorOffset(monitor),
            this._workspaceCount
        );
        const direction = localIndex > currentLocal ? 1 : -1;
        const transition = this._prepareWorkspaceTransition(
            monitor,
            target,
            direction
        );

        this._workspaceSwitching = true;
        try {
            this._rotateMonitor(monitor, activeIndex - targetIndex);
            this._retileWorkspace(global.workspace_manager.get_active_workspace());
        } finally {
            this._workspaceSwitching = false;
        }

        this._runWorkspaceTransition(transition);
        candidate?.activate(global.get_current_time());
    }

    _activeMonitor() {
        const win = global.display.focus_window;

        if (win)
            return win.get_monitor();

        return global.display.get_current_monitor();
    }

    _monitorConnector(monitor) {
        return this._monitorConnectors?.get(monitor)
            ?? Main.layoutManager.monitors[monitor]?.connector
            ?? `monitor-${monitor}`;
    }

    _refreshMonitorConnectors() {
        const proxy = this._displayConfigProxy;

        if (!proxy) return;

        proxy.GetCurrentStateRemote((state, error) => {
            if (error) {
                console.error(`[Dwindle] Cannot refresh monitor connectors: ${error}`);
                return;
            }

            if (proxy !== this._displayConfigProxy || !this._monitorWorkspaceOffsets)
                return;

            const [, monitors] = state;
            const monitorManager = global.backend.get_monitor_manager();
            const connectors = new Map();

            for (const [[connector]] of monitors) {
                const monitor = monitorManager.get_monitor_for_connector(connector);

                if (monitor >= 0) connectors.set(monitor, connector);
            }

            const migrations = new Map();

            for (const [monitor, connector] of connectors) {
                const fallback = `monitor-${monitor}`;

                if (!this._monitorWorkspaceOffsets.has(fallback)) continue;

                if (!this._monitorWorkspaceOffsets.has(connector))
                    this._monitorWorkspaceOffsets.set(
                        connector,
                        this._monitorWorkspaceOffsets.get(fallback)
                    );

                this._monitorWorkspaceOffsets.delete(fallback);
                migrations.set(fallback, connector);
            }

            if (migrations.size && this._trees) {
                const migratedTrees = new Map();

                for (const [key, tree] of this._trees) {
                    const parsed = parseTreeKey(key);
                    const connector = migrations.get(parsed.connector) ?? parsed.connector;

                    migratedTrees.set(treeKey(parsed.workspaceIndex, connector), tree);
                }

                this._trees = migratedTrees;
            }

            this._monitorConnectors = connectors;
            this._refreshSystemBars();
            this._normalizeMonitorWorkspaceOffsets();
            this._queueRetileAll();
        });
    }

    _refreshSystemBars() {
        this._destroySecondaryWorkspacePanels();
        this._destroyPrimarySystemBar();
        this._installPrimarySystemBar();

        if (!this._secondaryWorkspacePanels || !this._monitorConnectors) return;

        for (const [monitor, connector] of this._monitorConnectors) {
            if (!SECONDARY_PANEL_CONNECTORS.has(connector)) continue;

            const geometry = Main.layoutManager.monitors[monitor];

            if (!geometry) continue;

            const panel = new SecondarySystemBar(
                geometry,
                connector,
                this._workspaceCount,
                localIndex => this._switchLocalWorkspace(
                    localIndex,
                    null,
                    monitor
                ),
                this._settings.get_int('panel-spacing')
            );

            this._secondaryWorkspacePanels.set(connector, {monitor, panel});
        }

        this._updateSystemBars();
    }

    _updateSystemBars() {
        if (!this._settings) return;

        const activeWorkspace =
            global.workspace_manager.get_active_workspace_index();
        const title = this._focusedWindowTitle();
        const showTitle =
            this._settings.get_boolean('panel-show-focused-app');
        const primaryMonitor = Main.layoutManager.primaryIndex;

        this._primarySystemBar?.update(
            modulo(
                activeWorkspace - this._monitorOffset(primaryMonitor),
                this._workspaceCount
            ),
            title,
            showTitle
        );

        if (!this._secondaryWorkspacePanels) return;

        for (const {monitor, panel} of this._secondaryWorkspacePanels.values())
            panel.update(
                modulo(
                    activeWorkspace - this._monitorOffset(monitor),
                    this._workspaceCount
                ),
                title,
                showTitle
            );
    }

    _destroySecondaryWorkspacePanels() {
        if (!this._secondaryWorkspacePanels) return;

        for (const {panel} of this._secondaryWorkspacePanels.values())
            panel.destroy();

        this._secondaryWorkspacePanels.clear();
    }

    _monitorOffset(monitor) {
        const connector = this._monitorConnector(monitor);

        return this._monitorWorkspaceOffsets?.get(connector) ?? 0;
    }

    _actualWorkspaceForLocal(monitor, localIndex) {
        return actualWorkspaceForLocal(
            localIndex,
            this._monitorOffset(monitor),
            this._workspaceCount
        );
    }

    _loadMonitorWorkspaceOffsets() {
        try {
            const entries = JSON.parse(this._settings.get_string('monitor-workspace-offsets'));

            return new Map(Object.entries(entries).map(([connector, offset]) => [
                connector,
                modulo(Number(offset), this._workspaceCount),
            ]));
        } catch (_error) {
            return new Map();
        }
    }

    _saveMonitorWorkspaceOffsets() {
        if (!this._settings || !this._monitorWorkspaceOffsets) return;

        this._settings.set_string(
            'monitor-workspace-offsets',
            JSON.stringify(Object.fromEntries(this._monitorWorkspaceOffsets))
        );
        this._updateSystemBars();
    }

    _normalizeMonitorWorkspaceOffsets() {
        if (!this._monitorWorkspaceOffsets) return;

        for (const [connector, offset] of this._monitorWorkspaceOffsets)
            this._monitorWorkspaceOffsets.set(
                connector,
                modulo(offset, this._workspaceCount)
            );

        this._saveMonitorWorkspaceOffsets();
    }

    _onWorkspaceSwitch(from, to) {
        const fromIndex = typeof from === 'number' ? from : from?.index?.();
        const toIndex = typeof to === 'number' ? to : to?.index?.();

        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
            this._retileAll();
            this._updateSystemBars();
            return;
        }

        if (this._settings.get_boolean('monitor-local-workspaces'))
            this._rotateInactiveMonitors(
                this._activeMonitor(),
                toIndex - fromIndex
            );

        this._retileAll();
        this._updateSystemBars();
    }

    _rotateInactiveMonitors(stationaryMonitor, delta) {
        if (!delta) return;

        for (let monitor = 0; monitor < global.display.get_n_monitors(); monitor++) {
            if (monitor !== stationaryMonitor)
                this._rotateMonitor(monitor, delta, false);
        }

        this._saveMonitorWorkspaceOffsets();
    }

    _rotateMonitor(monitor, delta, save = true) {
        if (!delta || !this._trees || !this._monitorWorkspaceOffsets) return;

        const connector = this._monitorConnector(monitor);
        const rotatedTrees = new Map();

        for (const [key, tree] of this._trees)
            rotatedTrees.set(
                shiftTreeKeyForConnector(
                    key,
                    connector,
                    delta,
                    this._workspaceCount
                ),
                tree
            );

        this._trees = rotatedTrees;

        const offset = this._monitorWorkspaceOffsets.get(connector) ?? 0;
        this._monitorWorkspaceOffsets.set(
            connector,
            shiftedOffset(offset, delta, this._workspaceCount)
        );

        const movedWindows = [];

        for (const win of global.display.list_all_windows()) {
            if (win.get_monitor() !== monitor) continue;
            if (win.is_on_all_workspaces?.()) continue;

            const workspace = win.get_workspace();
            if (!workspace) continue;

            const targetIndex = modulo(workspace.index() + delta, this._workspaceCount);
            const target = global.workspace_manager.get_workspace_by_index(targetIndex);
            if (!target || target === workspace) continue;

            movedWindows.push(win);
            this._managedWorkspaceMoves.add(win);
            win.change_workspace(target);
        }

        if (movedWindows.length) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                for (const win of movedWindows)
                    this._managedWorkspaceMoves?.delete(win);

                return GLib.SOURCE_REMOVE;
            });
        }

        if (save)
            this._saveMonitorWorkspaceOffsets();
    }

    _onMonitorsChanged() {
        this._refreshMonitorConnectors();
    }

    _toggleTiling() {
        const current = this._settings.get_boolean('tiling-enabled');
        this._settings.set_boolean('tiling-enabled', !current);
        Main.notify('Tiling', !current ? 'Activado' : 'Desactivado');
    }

    _closeFocusedWindow() {
        const win = global.display.focus_window;
        if (!win) return;
        win.delete(global.get_current_time());
    }

    _toggleDecoration() {
        const win = global.display.focus_window;
        if (!win) {
            Main.notify('Tiling', 'No focused window');
            return;
        }
        if (win.is_client_decorated && win.is_client_decorated()) {
            Main.notify('Tiling',
                `${win.get_wm_class() || 'app'} uses client-side decorations, so Dwindle cannot hide its title bar.`);
            return;
        }
        try {
            const want = !win.decorated;
            if (typeof win.set_decorated === 'function')
                win.set_decorated(want);
            else
                win.decorated = want;
            Main.notify('Tiling',
                `Title bar: ${want ? 'visible' : 'hidden'}`);
        } catch (e) {
            Main.notify('Tiling',
                `Could not toggle the title bar: ${e.message}`);
        }
    }

    _toggleHelp() {
        if (this._helpDialog) {
            try { this._helpDialog.close(); } catch (_e) {}
            this._helpDialog = null;
            return;
        }

        const dialog = new ModalDialog.ModalDialog({styleClass: 'tiling-help-dialog'});

        const box = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 0; padding: 24px; min-width: 600px;',
        });

        const title = new St.Label({
            text: 'Tiling Shortcuts',
            x_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold; font-size: 15pt; padding-bottom: 16px;',
        });
        box.add_child(title);

        const search = new St.Entry({
            hint_text: 'Search shortcuts or actions...',
            style: 'padding: 8px 12px; margin-bottom: 14px;',
            track_hover: true,
            can_focus: true,
        });
        box.add_child(search);

        const wsCount = this._workspaceCount || 5;
        const arrows = '←  →  ↑  ↓';
        const mods = key => this._modsLabel(this._settings.get_strv(key)[0] || '');
        const accel = key => this._accelLabel(this._settings.get_strv(key)[0] || '');
        const dir = (key, sep = ' + ') => {
            const m = mods(key);
            return m ? `${m}${sep}${arrows}` : arrows;
        };
        const bindings = [
            [`Super  1..${wsCount}`, 'Switch to workspace N'],
            [`${mods('move-window-to-workspace-1')}  1..${wsCount}`, 'Move window to workspace N without switching'],
            [dir('focus-left'), 'Move focus in a direction'],
            [dir('move-window-left'), 'Swap with the adjacent window'],
            [dir('window-to-monitor-left'), 'Move window to the adjacent monitor'],
            [dir('resize-left'), 'Resize (configurable step)'],
            [accel('rotate-split'), 'Rotate split (vertical <-> horizontal)'],
            [accel('open-terminal'), 'Open terminal'],
            [accel('screenshot-region'), 'Select a region and open it in Swappy'],
            [accel('toggle-monocle'), 'Monocle: show only the focused window'],
            [accel('toggle-tiling'), 'Toggle tiling'],
            [accel('toggle-floating'), 'Toggle the window between tiled and floating'],
            [accel('float-next-window'), 'Float the next window'],
            [accel('close-window'), 'Close the focused window'],
            [accel('toggle-decoration'), 'Toggle title bar (SSD only)'],
            [accel('show-focused-info'), 'Show focused window WM_CLASS'],
            [accel('show-help'), 'Show/hide this help'],
        ];

        const card = new St.BoxLayout({
            vertical: true,
            style: 'background-color: rgba(255,255,255,0.05); border-radius: 12px;',
        });
        box.add_child(card);

        const rowInfo = [];
        bindings.forEach(([keys, desc], i) => {
            if (i > 0) {
                card.add_child(new St.Widget({
                    height: 1, x_expand: true,
                    style: 'background-color: rgba(255,255,255,0.08);',
                }));
            }
            const row = new St.BoxLayout({
                style: 'spacing: 16px; padding: 12px 16px;',
            });
            const descLabel = new St.Label({
                text: desc,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 11pt;',
            });
            const keyLabel = new St.Label({
                text: keys,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: rgba(255,255,255,0.55); font-size: 11pt;',
            });
            row.add_child(descLabel);
            row.add_child(keyLabel);
            card.add_child(row);
            rowInfo.push({
                widget: row,
                sep: i > 0 ? card.get_child_at_index(card.get_n_children() - 2) : null,
                keys: keys.toLowerCase(),
                desc: desc.toLowerCase(),
            });
        });

        const noResults = new St.Label({
            text: 'No matches',
            style: 'opacity: 0.5; padding: 12px 4px;',
            visible: false,
        });
        box.add_child(noResults);

        const hint = new St.Label({
            text: 'Esc or Super+F1 closes  ·  customize shortcuts in Preferences',
            x_align: Clutter.ActorAlign.CENTER,
            style: 'opacity: 0.6; padding-top: 14px; font-size: 9pt;',
        });
        box.add_child(hint);

        search.clutter_text.connect('text-changed', () => {
            const q = search.get_text().toLowerCase().trim();
            let matches = 0;
            for (const {widget, sep, keys, desc} of rowInfo) {
                const match = !q || keys.includes(q) || desc.includes(q);
                widget.visible = match;
                if (sep) sep.visible = match;
                if (match) matches++;
            }
            noResults.visible = matches === 0;
        });

        dialog.contentLayout.add_child(box);
        dialog.addButton({
            label: 'Close',
            action: () => dialog.close(),
            key: Clutter.KEY_Escape,
        });

        dialog.connect('closed', () => {
            if (this._helpDialog === dialog) this._helpDialog = null;
        });

        dialog.open();
        this._helpDialog = dialog;

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._helpDialog === dialog && search.clutter_text)
                search.clutter_text.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _modsLabel(accel) {
        const map = {
            super: 'Super', control: 'Ctrl', primary: 'Ctrl', shift: 'Shift',
            alt: 'Alt', mod1: 'Alt', meta: 'Meta', hyper: 'Hyper',
        };
        const found = accel.match(/<([^>]+)>/g) || [];
        return found
            .map(s => map[s.slice(1, -1).toLowerCase()] || s.slice(1, -1))
            .join(' + ');
    }

    _accelLabel(accel) {
        if (!accel) return 'Unassigned';
        const keyMap = {
            Left: '←', Right: '→', Up: '↑', Down: '↓',
            Return: 'Enter', space: 'Space', slash: '/', BackSpace: '⌫',
        };
        let key = accel.replace(/<[^>]+>/g, '');
        key = keyMap[key] || key;
        if (key.length === 1) key = key.toUpperCase();
        const mods = this._modsLabel(accel);
        return mods ? `${mods} + ${key}` : key;
    }

    _openTerminal() {
        if (!this._settings) return;
        const cmd = (this._settings.get_string('terminal-command') || '').trim();
        if (!cmd) {
            Main.notify('Tiling',
                'No terminal is configured. Open Dwindle Preferences.');
            return;
        }
        try {
            const [ok, argv] = GLib.shell_parse_argv(cmd);
            if (!ok || !argv || argv.length === 0)
                throw new Error('empty or invalid command');
            Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
            );
        } catch (e) {
            Main.notify('Tiling', `Could not open terminal "${cmd}": ${e.message}`);
        }
    }

    _resize(dir) {
        const win = global.display.focus_window;
        if (!win || !this._trees) return;
        if (this._floatingWindows && this._floatingWindows.has(win)) return;

        const ws = win.get_workspace();
        const monitor = win.get_monitor();
        if (!ws) return;
        const tree = this._trees.get(this._treeKey(ws, monitor));
        if (!tree) return;

        const workArea = ws.get_work_area_for_monitor(monitor);
        const innerArea = this._innerArea(workArea);

        const wantDir = (dir === 'left' || dir === 'right') ? 'v' : 'h';
        const stepPx = this._settings ? this._settings.get_int('resize-step-px') : 10;

        const result = this._findClosestSplit(tree, win, wantDir, innerArea);
        if (!result) return;

        const {split, rect} = result;
        const gap = this._settings ? this._settings.get_int('gap-size') : 0;
        const effective = (wantDir === 'v' ? rect.width : rect.height) - gap;
        if (effective <= 0) return;

        const deltaRatio = stepPx / effective;
        const signed = (dir === 'right' || dir === 'down') ? deltaRatio : -deltaRatio;

        split.ratio = Math.max(0.1, Math.min(0.9, split.ratio + signed));
        this._retileWorkspace(ws);
    }

    _findClosestSplit(node, win, wantDir, currentRect) {
        if (!node || node.kind === 'leaf') return null;

        const inA = this._findLeaf(node.a, win) !== null;
        const inB = !inA && this._findLeaf(node.b, win) !== null;
        if (!inA && !inB) return null;

        const [aRect, bRect] = this._splitRect(currentRect, node.dir, node.ratio);
        const child = inA ? node.a : node.b;
        const childRect = inA ? aRect : bRect;

        const deeper = this._findClosestSplit(child, win, wantDir, childRect);
        if (deeper) return deeper;
        if (node.dir === wantDir) return {split: node, rect: currentRect};
        return null;
    }

    // Rota la orientacion del split inmediato que contiene a la ventana con
    // foco: si estaba lado a lado ('v') pasa a una encima de otra ('h') y
    // viceversa. Solo afecta a esa ventana y su vecina directa en el arbol.
    _toggleSplitOrientation() {
        const win = global.display.focus_window;
        if (!win || !this._isTileable(win) || !this._trees) return;
        if (this._floatingWindows && this._floatingWindows.has(win)) return;

        const ws = win.get_workspace();
        const monitor = win.get_monitor();
        if (!ws) return;
        const tree = this._trees.get(this._treeKey(ws, monitor));
        if (!tree) return;

        const parent = this._findParentSplit(tree, win);
        if (!parent) return; // unica ventana del monitor: no hay split que rotar

        parent.dir = (parent.dir === 'v') ? 'h' : 'v';
        this._retileWorkspace(ws);
    }

    // Devuelve el split cuyo hijo directo (a o b) es la hoja de win, es decir
    // el padre inmediato de esa ventana en el arbol.
    _findParentSplit(node, win) {
        if (!node || node.kind === 'leaf') return null;
        if ((node.a.kind === 'leaf' && node.a.win === win)
            || (node.b.kind === 'leaf' && node.b.win === win))
            return node;
        return this._findParentSplit(node.a, win)
            || this._findParentSplit(node.b, win);
    }

    _showFocusedInfo() {
        const win = global.display.focus_window;
        if (!win) {
            Main.notify('Tiling', 'No focused window');
            return;
        }
        const cls = win.get_wm_class() || '(empty)';
        const inst = win.get_wm_class_instance() || '(empty)';
        const title = win.get_title() || '(untitled)';
        const msg = `class: ${cls}\ninstance: ${inst}\ntitle: ${title}`;
        Main.notify('Focused window', msg);
        console.log(`[tiling] focused window — ${msg.replace(/\n/g, ' | ')}`);
    }

    _focusDirection(dir) {
        const target = this._findWindowInDirection(global.display.focus_window, dir);
        if (target) {
            target.activate(global.get_current_time());
            this._warpPointerToWindow(target);
        }
    }

    // Centra el puntero en la ventana indicada (si el ajuste esta activo).
    // Asi el cursor sigue al foco al navegar entre ventanas o monitores.
    _warpPointerToWindow(win) {
        if (!win || !this._settings) return;
        if (!this._settings.get_boolean('warp-pointer-on-focus')) return;
        let rect;
        try { rect = win.get_frame_rect(); } catch (_e) { return; }
        if (!rect) return;
        const x = Math.round(rect.x + rect.width / 2);
        const y = Math.round(rect.y + rect.height / 2);
        try {
            Clutter.get_default_backend().get_default_seat().warp_pointer(x, y);
        } catch (e) {
            console.error(`[tiling] warp_pointer failed: ${e}`);
        }
    }

    _findWindowInDirection(focus, dir) {
        if (!focus) return null;
        const workspace = focus.get_workspace();
        if (!workspace) return null;

        // Sin filtro de monitor: candidatas de TODO el workspace. La metrica
        // direccional de abajo elige la mas cercana en esa direccion, asi que
        // las del mismo monitor (mas proximas) ganan, y al llegar al borde el
        // foco cruza de forma natural al monitor vecino.
        const candidates = workspace.list_windows().filter(w =>
            w !== focus
            && !w.minimized
            && w.get_window_type() === Meta.WindowType.NORMAL
            && !w.is_skip_taskbar()
            && !(this._floatingWindows && this._floatingWindows.has(w))
        );

        const fr = focus.get_frame_rect();
        const fc = {x: fr.x + fr.width / 2, y: fr.y + fr.height / 2};

        let best = null;
        let bestDist = Infinity;

        for (const cand of candidates) {
            const cr = cand.get_frame_rect();
            const cc = {x: cr.x + cr.width / 2, y: cr.y + cr.height / 2};
            const dx = cc.x - fc.x;
            const dy = cc.y - fc.y;

            let inDir = false;
            let dist = 0;
            switch (dir) {
                case 'left':
                    inDir = dx < 0 && Math.abs(dx) >= Math.abs(dy);
                    dist = -dx + Math.abs(dy) * 2;
                    break;
                case 'right':
                    inDir = dx > 0 && Math.abs(dx) >= Math.abs(dy);
                    dist = dx + Math.abs(dy) * 2;
                    break;
                case 'up':
                    inDir = dy < 0 && Math.abs(dy) >= Math.abs(dx);
                    dist = -dy + Math.abs(dx) * 2;
                    break;
                case 'down':
                    inDir = dy > 0 && Math.abs(dy) >= Math.abs(dx);
                    dist = dy + Math.abs(dx) * 2;
                    break;
            }

            if (inDir && dist < bestDist) {
                best = cand;
                bestDist = dist;
            }
        }

        return best;
    }

    _moveWindow(dir) {
        const win = global.display.focus_window;
        if (!win || !this._isTileable(win)) return;
        const targetLeaf = this._bspNeighborLeaf(win, dir);
        if (!targetLeaf) return;
        const target = targetLeaf.win;
        if (!target || target === win || !this._isTileable(target)) return;
        if (!this._swapInTree(win, target)) return;
        this._retileWorkspace(win.get_workspace());
        // Tras el swap la ventana movida cambia de sitio pero el puntero no.
        // Con focus-follows-mouse el cursor quedaria sobre la otra ventana y
        // el foco saltaria a ella. Reafirmamos el foco y llevamos el puntero
        // a la ventana que movimos, igual que en _moveToMonitor/_focusDirection.
        win.activate(global.get_current_time());
        this._trackFocusedTileable();
        this._warpPointerToWindow(win);
    }

    _moveToMonitor(dir) {
        const win = global.display.focus_window;
        if (!win || !this._isTileable(win)) return;
        if (global.display.get_n_monitors() <= 1) return;

        const ws = win.get_workspace();
        const fromMonitor = win.get_monitor();
        const target = this._findMonitorInDirection(fromMonitor, dir);
        if (target < 0) return;

        this._removeFromTree(win);
        this._managedMonitorMoves.add(win);
        win.move_to_monitor(target);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._managedMonitorMoves?.delete(win);
            return GLib.SOURCE_REMOVE;
        });
        // move_to_monitor solo conserva el desplazamiento en pixeles y no
        // redimensiona: una ventana mas ancha/alta que el monitor destino
        // (p.ej. una ventana tiled que pasa a un monitor rotado y estrecho)
        // sigue solapando mas el monitor de origen, asi que get_monitor()
        // devolveria el monitor equivocado y el retile la dejaria donde estaba.
        // Forzamos la ventana dentro del area del destino y la insertamos en el
        // arbol de ESE monitor por indice, sin depender de get_monitor().
        if (this._isTileable(win)) {
            this._placeWindow(win, this._innerArea(ws.get_work_area_for_monitor(target)));
            this._addToTree(win, null, target);
        }
        // _retileWorkspace recorre todos los monitores del workspace,
        // asi que reacomoda tanto el monitor de origen como el destino.
        this._retileWorkspace(ws);
        this._trackFocusedTileable();
        win.activate(global.get_current_time());
        this._warpPointerToWindow(win);
    }

    _findMonitorInDirection(fromMonitor, dir) {
        const n = global.display.get_n_monitors();
        if (n <= 1) return -1;
        const from = global.display.get_monitor_geometry(fromMonitor);
        const fc = {x: from.x + from.width / 2, y: from.y + from.height / 2};

        let best = -1;
        let bestDist = Infinity;
        for (let i = 0; i < n; i++) {
            if (i === fromMonitor) continue;
            const g = global.display.get_monitor_geometry(i);
            const cc = {x: g.x + g.width / 2, y: g.y + g.height / 2};
            const dx = cc.x - fc.x;
            const dy = cc.y - fc.y;

            let inDir = false;
            let dist = 0;
            switch (dir) {
                case 'left':
                    inDir = dx < 0 && Math.abs(dx) >= Math.abs(dy);
                    dist = -dx + Math.abs(dy) * 2;
                    break;
                case 'right':
                    inDir = dx > 0 && Math.abs(dx) >= Math.abs(dy);
                    dist = dx + Math.abs(dy) * 2;
                    break;
                case 'up':
                    inDir = dy < 0 && Math.abs(dy) >= Math.abs(dx);
                    dist = -dy + Math.abs(dx) * 2;
                    break;
                case 'down':
                    inDir = dy > 0 && Math.abs(dy) >= Math.abs(dx);
                    dist = dy + Math.abs(dx) * 2;
                    break;
            }
            if (inDir && dist < bestDist) {
                best = i;
                bestDist = dist;
            }
        }
        return best;
    }

    _swapInTree(winA, winB) {
        if (!this._trees) return false;
        for (const tree of this._trees.values()) {
            const leafA = this._findLeaf(tree, winA);
            const leafB = this._findLeaf(tree, winB);
            if (leafA && leafB) {
                leafA.win = winB;
                leafB.win = winA;
                return true;
            }
        }
        return false;
    }

    _bspNeighborLeaf(win, dir) {
        if (!this._trees) return null;
        const wantDir = (dir === 'left' || dir === 'right') ? 'v' : 'h';
        const goToB = (dir === 'right' || dir === 'down');

        for (const tree of this._trees.values()) {
            const path = [];
            if (!this._findPath(tree, win, path)) continue;
            for (let i = 0; i < path.length; i++) {
                const {node, side} = path[i];
                if (node.dir !== wantDir) continue;
                if (goToB && side === 'a')
                    return this._leafAtEdge(node.b, wantDir, true);
                if (!goToB && side === 'b')
                    return this._leafAtEdge(node.a, wantDir, false);
            }
            return null;
        }
        return null;
    }

    _findPath(node, win, path) {
        if (!node) return false;
        if (node.kind === 'leaf') return node.win === win;
        if (this._findPath(node.a, win, path)) {
            path.push({node, side: 'a'});
            return true;
        }
        if (this._findPath(node.b, win, path)) {
            path.push({node, side: 'b'});
            return true;
        }
        return false;
    }

    _leafAtEdge(node, axis, takeFirst) {
        let cur = node;
        while (cur && cur.kind === 'split') {
            if (cur.dir === axis) cur = takeFirst ? cur.a : cur.b;
            else cur = cur.a;
        }
        return cur && cur.kind === 'leaf' ? cur : null;
    }

    _toggleFloating() {
        const win = global.display.focus_window;
        if (!win || !this._floatingWindows) return;
        if (this._floatingWindows.has(win)) {
            this._floatingWindows.delete(win);
            if (this._isTileable(win)) this._addToTree(win, null);
            Main.notify('Tiling', `${win.get_wm_class() || 'window'}: tiled`);
        } else {
            this._floatingWindows.add(win);
            this._removeFromTree(win);
            Main.notify('Tiling', `${win.get_wm_class() || 'window'}: floating`);
        }
        this._retileWorkspace(win.get_workspace());
    }

    // One-shot: arma (o cancela) que la PROXIMA ventana normal que se abra
    // entre como flotante en vez de tiled. Se consume en
    // _handleExistingOrNewWindow al crearse esa ventana.
    _armFloatNext() {
        this._floatNextWindow = !this._floatNextWindow;
        if (this._floatNextWindow) this._showFloatNextIndicator();
        else this._hideFloatNextIndicator();
        Main.notify('Tiling', this._floatNextWindow
            ? 'The next window will open floating'
            : 'Canceled: the next window will be tiled');
    }

    // Icono en el panel (lado derecho) mientras el modo one-shot esta armado.
    // Pulsarlo cancela el modo. Se destruye al consumirse o al cancelar.
    _showFloatNextIndicator() {
        if (this._floatNextButton) return;
        const button = new PanelMenu.Button(0.0, 'TilingFloatNext', true);
        button.add_child(new St.Icon({
            icon_name: 'window-new-symbolic',
            style_class: 'system-status-icon',
        }));
        button.connect('button-press-event', () => {
            this._floatNextWindow = false;
            this._hideFloatNextIndicator();
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea('tilingFloatNext', button, -1, 'right');
        this._floatNextButton = button;
    }

    _hideFloatNextIndicator() {
        if (this._floatNextButton) {
            this._floatNextButton.destroy();
            this._floatNextButton = null;
        }
    }

    _onGrabOpEnd(win) {
        if (!win || !this._settings) return;
        if (!this._settings.get_boolean('strict-tiling')) return;
        if (!this._settings.get_boolean('tiling-enabled')) return;
        if (this._floatingWindows && this._floatingWindows.has(win)) return;
        if (!this._isTileable(win)) return;
        this._retileWorkspace(win.get_workspace());
    }

    _handleExistingOrNewWindow(win, splitTarget = null) {
        this._trackWindow(win);
        if (!this._settings || !this._floatingWindows) return;
        const floatClasses = this._settings.get_strv('floating-window-classes');
        const cls = win.get_wm_class() || '';
        const clsInst = win.get_wm_class_instance() || '';
        if (floatClasses.includes(cls) || floatClasses.includes(clsInst))
            this._floatingWindows.add(win);
        // Modo one-shot "la proxima ventana flota": solo lo consume una ventana
        // normal (no dialogos/utilidades transitorias) y se desarma al usarse.
        if (this._floatNextWindow
            && win.get_window_type() === Meta.WindowType.NORMAL
            && !win.is_skip_taskbar()) {
            this._floatingWindows.add(win);
            this._floatNextWindow = false;
            this._hideFloatNextIndicator();
        }
        if (this._isTileable(win)) {
            // A new tiling window breaks the "single window" illusion: drop
            // monocle so it lays out alongside the restored windows.
            if (this._monocleWin && this._monocleWin !== win) this._exitMonocle();
            this._addToTree(win, splitTarget);
            this._trackFocusedTileable();
        }
    }

    _reapplyFloatingClasses() {
        if (!this._floatingWindows || !this._windowSignals || !this._settings) return;
        const classes = new Set(this._settings.get_strv('floating-window-classes'));
        for (const win of this._windowSignals.keys()) {
            const cls = win.get_wm_class() || '';
            const clsInst = win.get_wm_class_instance() || '';
            const inList = classes.has(cls) || classes.has(clsInst);
            const wasFloating = this._floatingWindows.has(win);
            if (inList) {
                this._floatingWindows.add(win);
                if (!wasFloating) this._removeFromTree(win);
            } else {
                this._floatingWindows.delete(win);
                if (wasFloating && this._isTileable(win))
                    this._addToTree(win, null);
            }
        }
    }

    _onWindowCreated(win) {
        const splitTarget = this._lastFocusedTileable;
        const actor = win.get_compositor_private();
        if (!actor || !this._pendingFirstFrame) return;
        const entry = {actor, id: 0};
        entry.id = actor.connect('first-frame', () => {
            actor.disconnect(entry.id);
            if (this._pendingFirstFrame) this._pendingFirstFrame.delete(entry);
            this._handleExistingOrNewWindow(win, splitTarget);
            this._retileWorkspace(win.get_workspace());
        });
        this._pendingFirstFrame.add(entry);
    }

    _trackFocusedTileable() {
        const win = global.display.focus_window;
        if (!win || !this._isTileable(win) || !this._trees) return;
        for (const tree of this._trees.values()) {
            if (this._findLeaf(tree, win)) {
                this._lastFocusedTileable = win;
                return;
            }
        }
    }

    _trackWindow(win) {
        if (!this._windowSignals || this._windowSignals.has(win)) return;
        const ids = [];
        ids.push(win.connect('unmanaged', () => this._onWindowUnmanaged(win)));
        ids.push(win.connect('workspace-changed', () => this._onWindowWorkspaceChanged(win)));
        ids.push(win.connect('notify::monitor', () => this._onWindowMonitorChanged(win)));
        this._windowSignals.set(win, ids);
    }

    _onWindowUnmanaged(win) {
        if (!this._windowSignals) return;
        const ids = this._windowSignals.get(win);
        if (ids) {
            for (const id of ids) {
                try { win.disconnect(id); } catch (_e) {}
            }
            this._windowSignals.delete(win);
        }
        if (this._floatingWindows) this._floatingWindows.delete(win);
        if (this._lastFocusedTileable === win) this._lastFocusedTileable = null;
        if (this._monocleWin === win) this._exitMonocle();
        this._removeFromTree(win);
        this._queueRetileAll();
    }

    _onWindowWorkspaceChanged(win) {
        if (this._managedWorkspaceMoves?.delete(win)) return;

        this._removeFromTree(win);
        if (this._isTileable(win))
            this._addToTree(win, null);
        this._queueRetileAll();
    }

    _onWindowMonitorChanged(win) {
        if (this._managedMonitorMoves?.delete(win)) return;

        this._removeFromTree(win);
        if (this._isTileable(win))
            this._addToTree(win, null);
        this._queueRetileAll();
    }

    _isTileable(win) {
        if (!win) return false;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (win.is_skip_taskbar()) return false;
        if (win.fullscreen) return false;
        if (win.minimized) return false;
        if (this._floatingWindows && this._floatingWindows.has(win)) return false;
        return true;
    }

    // Retile diferido: NUNCA llamar a move_resize_frame (lo hace _retileAll ->
    // _placeWindow) de forma sincrona dentro de una señal de ciclo de vida de
    // ventana como 'unmanaged'. En Wayland mutter aun esta desmontando la
    // superficie y recomputar el monitor de la ventana (meta_window_update_
    // monitor) sobre ese estado a medio destruir segfaultea todo gnome-shell.
    // Diferir a un idle deja que mutter termine primero; ademas agrupa varios
    // retiles seguidos en uno solo.
    _queueRetileAll() {
        if (this._retileQueued) return;
        this._retileQueued = true;
        this._retileSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._retileQueued = false;
            this._retileSourceId = 0;
            this._retileAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _retileAll() {
        if (!this._settings || !this._settings.get_boolean('tiling-enabled'))
            return;
        const wsManager = global.workspace_manager;
        for (let i = 0; i < wsManager.n_workspaces; i++)
            this._retileWorkspace(wsManager.get_workspace_by_index(i));
    }

    _retileWorkspace(workspace) {
        if (!workspace || !this._settings || !this._trees) return;
        if (!this._settings.get_boolean('tiling-enabled')) return;

        const nMonitors = global.display.get_n_monitors();
        for (let m = 0; m < nMonitors; m++) {
            const key = this._treeKey(workspace, m);
            const tree = this._trees.get(key);
            if (!tree) continue;
            const workArea = workspace.get_work_area_for_monitor(m);
            if (this._monocleOnMonitor(workspace, m)) {
                this._placeWindow(this._monocleWin, this._innerArea(workArea));
                continue;
            }
            this._applyTreeLayout(tree, this._innerArea(workArea));
        }
    }

    _monocleValid() {
        const win = this._monocleWin;
        if (!win) return false;
        try { return win.get_workspace() !== null; } catch (_e) { return false; }
    }

    _monocleOnMonitor(workspace, monitor) {
        if (!this._monocleValid()) return false;
        return this._monocleWin.get_workspace() === workspace
            && this._monocleWin.get_monitor() === monitor;
    }

    // === BSP tree ===
    // Node shapes:
    //   leaf:  {kind: 'leaf', win}
    //   split: {kind: 'split', dir: 'v'|'h', ratio: 0.5, a, b}
    // dir 'v' = vertical line, splits area left/right
    // dir 'h' = horizontal line, splits area top/bottom

    _treeKey(workspace, monitor) {
        return treeKey(workspace.index(), this._monitorConnector(monitor));
    }

    _innerArea(workArea) {
        const gap = this._settings ? this._settings.get_int('gap-size') : 0;
        return {
            x: workArea.x + gap,
            y: workArea.y + gap,
            width: workArea.width - 2 * gap,
            height: workArea.height - 2 * gap,
        };
    }

    _addToTree(win, preferredTarget, monitorOverride = null) {
        if (!this._trees) return;
        const workspace = win.get_workspace();
        if (!workspace) return;
        const monitor = (monitorOverride !== null) ? monitorOverride : win.get_monitor();
        const key = this._treeKey(workspace, monitor);

        let tree = this._trees.get(key);
        if (!tree) {
            this._trees.set(key, {kind: 'leaf', win});
            return;
        }
        if (this._findLeaf(tree, win)) return;

        const workArea = workspace.get_work_area_for_monitor(monitor);
        const innerArea = this._innerArea(workArea);

        let targetLeaf = null;
        if (preferredTarget && preferredTarget !== win)
            targetLeaf = this._findLeaf(tree, preferredTarget);
        if (!targetLeaf)
            targetLeaf = this._largestLeaf(tree, innerArea).leaf;

        const targetRect = this._getLeafRect(tree, targetLeaf, innerArea);
        const dir = (targetRect && targetRect.width >= targetRect.height) ? 'v' : 'h';

        const split = {
            kind: 'split',
            dir, ratio: 0.5,
            a: targetLeaf,
            b: {kind: 'leaf', win},
        };
        this._trees.set(key, this._replaceLeaf(tree, targetLeaf, split));
    }

    _removeFromTree(win) {
        if (!this._trees) return;
        for (const [key, tree] of this._trees) {
            const newTree = this._removeLeaf(tree, win);
            if (newTree !== tree) {
                if (newTree === null) this._trees.delete(key);
                else this._trees.set(key, newTree);
                return;
            }
        }
    }

    _findLeaf(node, win) {
        if (!node) return null;
        if (node.kind === 'leaf') return node.win === win ? node : null;
        return this._findLeaf(node.a, win) || this._findLeaf(node.b, win);
    }

    _replaceLeaf(node, target, replacement) {
        if (node === target) return replacement;
        if (node.kind === 'leaf') return node;
        const newA = this._replaceLeaf(node.a, target, replacement);
        const newB = this._replaceLeaf(node.b, target, replacement);
        if (newA === node.a && newB === node.b) return node;
        return {...node, a: newA, b: newB};
    }

    _removeLeaf(node, win) {
        if (!node) return null;
        if (node.kind === 'leaf') return node.win === win ? null : node;
        const newA = this._removeLeaf(node.a, win);
        const newB = this._removeLeaf(node.b, win);
        if (newA === null && newB === null) return null;
        if (newA === null) return newB;
        if (newB === null) return newA;
        if (newA === node.a && newB === node.b) return node;
        return {...node, a: newA, b: newB};
    }

    _largestLeaf(node, rect) {
        if (node.kind === 'leaf') return {leaf: node, area: rect.width * rect.height};
        const [aRect, bRect] = this._splitRect(rect, node.dir, node.ratio);
        const a = this._largestLeaf(node.a, aRect);
        const b = this._largestLeaf(node.b, bRect);
        return a.area >= b.area ? a : b;
    }

    _getLeafRect(node, target, rect) {
        if (node === target) return rect;
        if (node.kind === 'leaf') return null;
        const [aRect, bRect] = this._splitRect(rect, node.dir, node.ratio);
        return this._getLeafRect(node.a, target, aRect)
            || this._getLeafRect(node.b, target, bRect);
    }

    _splitRect(rect, dir, ratio) {
        const gap = this._settings ? this._settings.get_int('gap-size') : 0;
        if (dir === 'v') {
            const aw = Math.floor((rect.width - gap) * ratio);
            return [
                {x: rect.x, y: rect.y, width: aw, height: rect.height},
                {x: rect.x + aw + gap, y: rect.y, width: rect.width - aw - gap, height: rect.height},
            ];
        }
        const ah = Math.floor((rect.height - gap) * ratio);
        return [
            {x: rect.x, y: rect.y, width: rect.width, height: ah},
            {x: rect.x, y: rect.y + ah + gap, width: rect.width, height: rect.height - ah - gap},
        ];
    }

    _applyTreeLayout(node, rect) {
        if (!node) return;
        if (node.kind === 'leaf') {
            this._placeWindow(node.win, rect);
            return;
        }
        const [aRect, bRect] = this._splitRect(rect, node.dir, node.ratio);
        this._applyTreeLayout(node.a, aRect);
        this._applyTreeLayout(node.b, bRect);
    }

    _windowAnimationAllowed(win, setting = 'animations-enabled') {
        if (!this._animationsReady || this._workspaceSwitching) return false;
        if (!this._settings?.get_boolean(setting)) return false;
        if (!win || win.fullscreen || win.minimized) return false;

        const wmClass = (win.get_wm_class() || '').toLowerCase();
        const wmClassInstance = (win.get_wm_class_instance() || '').toLowerCase();

        return !this._animationDisabledClasses?.has(wmClass)
            && !this._animationDisabledClasses?.has(wmClassInstance);
    }

    _visualFrameRect(win, actor) {
        const rect = win.get_frame_rect();

        if (!actor || !this._animatedActors?.has(actor))
            return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};

        return {
            x: rect.x + actor.translation_x,
            y: rect.y + actor.translation_y,
            width: rect.width * actor.scale_x,
            height: rect.height * actor.scale_y,
        };
    }

    _resetActorAnimation(actor, restoreOpacity = true) {
        if (!actor) return;

        const sourceId = this._pendingWindowAnimations?.get(actor);
        const tracked = Boolean(sourceId) || this._animatedActors?.has(actor);
        if (!tracked) return;
        if (sourceId) {
            try { laterRemove(sourceId); } catch (_error) {}
            this._pendingWindowAnimations.delete(actor);
        }

        try {
            actor.remove_all_transitions();
            actor.set_translation(0, 0, 0);
            actor.set_scale(1, 1);
            if (restoreOpacity) actor.opacity = 255;
        } catch (_error) {}

        this._animatedActors?.delete(actor);
    }

    _queueWindowAnimation(win, actor, from, to) {
        if (!this._windowAnimationAllowed(win)) return;
        if (!geometryChanged(from, to)) return;

        const duration = this._settings.get_int('animation-duration-ms');
        if (duration <= 0) return;

        const transform = flipTransform(from, to);
        let sourceId = 0;

        this._animatedActors.add(actor);
        sourceId = laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            this._pendingWindowAnimations?.delete(actor);

            try {
                if (!actor.get_parent()) {
                    this._animatedActors?.delete(actor);
                    return;
                }

                actor.set_pivot_point(0, 0);
                actor.set_translation(
                    transform.translationX,
                    transform.translationY,
                    0
                );
                actor.set_scale(transform.scaleX, transform.scaleY);
                actor.ease({
                    translation_x: 0,
                    translation_y: 0,
                    scale_x: 1,
                    scale_y: 1,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        this._animatedActors?.delete(actor);
                    },
                });
            } catch (_error) {
                this._resetActorAnimation(actor);
            }
        });
        this._pendingWindowAnimations.set(actor, sourceId);
    }

    _prepareWorkspaceTransition(monitor, targetWorkspace, direction) {
        if (!this._animationsReady) return null;
        if (!this._settings.get_boolean('workspace-animations-enabled')) return null;

        const duration = this._settings.get_int('workspace-animation-duration-ms');
        if (duration <= 0 || !targetWorkspace) return null;

        const monitorGeometry = global.display.get_monitor_geometry(monitor);
        const activeWorkspace = global.workspace_manager.get_active_workspace();
        const outgoingActors = activeWorkspace.list_windows()
            .filter(win =>
                win.get_monitor() === monitor
                && this._windowAnimationAllowed(win, 'workspace-animations-enabled')
            )
            .map(win => win.get_compositor_private())
            .filter(Boolean);
        const incomingActors = targetWorkspace.list_windows()
            .filter(win =>
                win.get_monitor() === monitor
                && this._windowAnimationAllowed(win, 'workspace-animations-enabled')
            )
            .map(win => win.get_compositor_private())
            .filter(Boolean);

        if (!outgoingActors.length && !incomingActors.length)
            return null;

        const container = new Clutter.Actor({
            x: monitorGeometry.x,
            y: monitorGeometry.y,
            width: monitorGeometry.width,
            height: monitorGeometry.height,
            clip_to_allocation: true,
            reactive: false,
        });

        global.window_group.add_child(container);
        this._workspaceCloneContainers.add(container);

        for (const actor of outgoingActors) {
            this._resetActorAnimation(actor);

            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            const clone = new Clutter.Clone({
                source: actor,
                x: x - monitorGeometry.x,
                y: y - monitorGeometry.y,
                width,
                height,
                reactive: false,
            });

            container.add_child(clone);
        }

        for (const actor of incomingActors) {
            this._resetActorAnimation(actor);
            actor.opacity = 0;
            this._animatedActors.add(actor);
        }

        return {
            container,
            direction,
            duration,
            incomingActors,
            distance: Math.round(monitorGeometry.width * 0.18),
        };
    }

    _runWorkspaceTransition(transition) {
        if (!transition) return;

        const {
            container,
            direction,
            duration,
            incomingActors,
            distance,
        } = transition;
        let sourceId = 0;

        sourceId = laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            this._workspaceAnimationSources?.delete(sourceId);

            try {
                container.ease({
                    translation_x: -direction * distance,
                    opacity: 0,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        this._workspaceCloneContainers?.delete(container);
                        container.destroy();
                    },
                });

                for (const actor of incomingActors) {
                    if (!actor.get_parent()) {
                        this._animatedActors?.delete(actor);
                        continue;
                    }

                    actor.set_translation(direction * distance, 0, 0);
                    actor.ease({
                        translation_x: 0,
                        opacity: 255,
                        duration,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => {
                            this._animatedActors?.delete(actor);
                        },
                    });
                }
            } catch (_error) {
                this._workspaceCloneContainers?.delete(container);
                try { container.destroy(); } catch (_destroyError) {}

                for (const actor of incomingActors)
                    this._resetActorAnimation(actor);
            }
        });
        this._workspaceAnimationSources.add(sourceId);
    }

    _cleanupAnimations() {
        if (this._animationReadySourceId) {
            GLib.source_remove(this._animationReadySourceId);
            this._animationReadySourceId = 0;
        }

        for (const sourceId of (this._pendingWindowAnimations?.values() ?? [])) {
            try { laterRemove(sourceId); } catch (_error) {}
        }
        this._pendingWindowAnimations?.clear();

        for (const sourceId of (this._workspaceAnimationSources ?? [])) {
            try { laterRemove(sourceId); } catch (_error) {}
        }
        this._workspaceAnimationSources?.clear();

        for (const actor of (this._animatedActors ?? []))
            this._resetActorAnimation(actor);
        this._animatedActors?.clear();

        for (const container of (this._workspaceCloneContainers ?? [])) {
            try { container.destroy(); } catch (_error) {}
        }
        this._workspaceCloneContainers?.clear();

        this._animationsReady = false;
        this._pendingWindowAnimations = null;
        this._workspaceAnimationSources = null;
        this._animatedActors = null;
        this._workspaceCloneContainers = null;
    }

    _placeWindow(win, rect) {
        try {
            const actor = win.get_compositor_private();
            const from = this._visualFrameRect(win, actor);

            this._resetActorAnimation(actor);

            if (win.maximized_horizontally || win.maximized_vertically)
                win.unmaximize();

            win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
            this._queueWindowAnimation(win, actor, from, rect);
        } catch (error) {
            console.error(`[tiling] _placeWindow failed for ${win.get_wm_class()}: ${error}`);
        }
    }

    // === Monocle (zoom) ===
    // Show only the focused window at full work-area size, minimizing the
    // other tiled windows on the same workspace+monitor. Toggle restores them.
    _toggleMonocle() {
        if (this._monocleWin) {
            this._exitMonocle();
            return;
        }
        const win = global.display.focus_window;
        if (!win || !this._isTileable(win)) return;
        const ws = win.get_workspace();
        if (!ws) return;
        const monitor = win.get_monitor();

        this._monocleHidden = [];
        for (const w of ws.list_windows()) {
            if (w === win || w.get_monitor() !== monitor) continue;
            if (!this._isTileable(w)) continue;
            try {
                w.minimize();
                this._monocleHidden.push(w);
            } catch (_e) {}
        }
        this._monocleWin = win;
        win.activate(global.get_current_time());
        this._placeWindow(win, this._innerArea(ws.get_work_area_for_monitor(monitor)));
        this._showMonocleIndicator();
        this._createMonocleBorder();
        this._updateMonocleVisuals();
    }

    _exitMonocle() {
        if (!this._monocleWin && !this._monocleButton) return;
        this._monocleWin = null;
        if (this._monocleHidden) {
            for (const w of this._monocleHidden) {
                try { w.unminimize(); } catch (_e) {}
            }
        }
        this._monocleHidden = null;
        this._hideMonocleIndicator();
        this._destroyMonocleBorder();
        // Diferido: _exitMonocle puede venir desde _onWindowUnmanaged (la
        // ventana en monoculo se cerro), asi que no retilamos sincronamente.
        this._queueRetileAll();
    }

    _showMonocleIndicator() {
        if (this._monocleButton) return;
        const button = new PanelMenu.Button(0.0, 'TilingMonocle', true);
        button.add_child(new St.Icon({
            icon_name: 'view-fullscreen-symbolic',
            style_class: 'system-status-icon',
        }));
        button.connect('button-press-event', () => {
            this._exitMonocle();
            return Clutter.EVENT_STOP;
        });
        // Append (-1) al box derecho para que el icono quede en el borde de ese
        // lado sin empujar los indicadores nativos.
        Main.panel.addToStatusArea('tilingMonocle', button, -1, 'right');
        this._monocleButton = button;
    }

    _hideMonocleIndicator() {
        if (this._monocleButton) {
            this._monocleButton.destroy();
            this._monocleButton = null;
        }
    }

    // El icono y las esquinas solo deben verse mientras la ventana en
    // monoculo TIENE el foco. Si el foco se va a otra ventana (p.ej. una
    // flotante o tras un alt-tab), ocultamos ambos; al volver, reaparecen.
    _updateMonocleVisuals() {
        const onMonocle = !!this._monocleWin
            && global.display.focus_window === this._monocleWin
            && !Main.overview.visible;
        if (this._monocleButton) {
            if (onMonocle) this._monocleButton.show();
            else this._monocleButton.hide();
        }
        if (onMonocle) this._showMonocleBorder();
        else this._hideMonocleBorder();
    }

    // Grosor de la linea y largo de los brazos de cada esquina. Reusamos el
    // ancho del borde de foco (con un minimo para que siempre se note).
    _monocleBorderMetrics() {
        const w = Math.max(2, this._settings
            ? this._settings.get_int('focus-border-width') : 2);
        return {width: w, len: Math.max(20, w * 6)};
    }

    // Cuatro marcas en L (estilo visor de camara), una por esquina, dibujadas
    // en el gap por fuera del marco. Ocupan lo mismo que un borde normal pero
    // dejan libres los lados, por eso "pesan" menos visualmente.
    _createMonocleBorder() {
        if (this._monocleBorder) return;
        const make = () => {
            const w = new St.Widget({reactive: false, can_focus: false, visible: false});
            global.window_group.add_child(w);
            return w;
        };
        this._monocleBorder = {tl: make(), tr: make(), bl: make(), br: make()};
        this._monocleGeomSignals = [];
        this._updateMonocleBorderStyle();
    }

    _destroyMonocleBorder() {
        if (this._monocleGeomSignals) {
            for (const {win, id} of this._monocleGeomSignals) {
                try { win.disconnect(id); } catch (_e) {}
            }
            this._monocleGeomSignals = null;
        }
        if (this._monocleBorder) {
            for (const w of Object.values(this._monocleBorder)) {
                const parent = w.get_parent();
                if (parent) parent.remove_child(w);
                w.destroy();
            }
            this._monocleBorder = null;
        }
    }

    // Cada esquina es un widget cuadrado transparente con borde SOLO en los
    // dos lados que forman la L (los otros dos quedan sin pintar).
    _updateMonocleBorderStyle() {
        if (!this._monocleBorder || !this._settings) return;
        const color = this._settings.get_string('focus-border-color');
        const {width: w} = this._monocleBorderMetrics();
        const b = `${w}px solid ${color}`;
        const bg = 'background-color: transparent;';
        this._monocleBorder.tl.set_style(`border-top: ${b}; border-left: ${b}; ${bg}`);
        this._monocleBorder.tr.set_style(`border-top: ${b}; border-right: ${b}; ${bg}`);
        this._monocleBorder.bl.set_style(`border-bottom: ${b}; border-left: ${b}; ${bg}`);
        this._monocleBorder.br.set_style(`border-bottom: ${b}; border-right: ${b}; ${bg}`);
    }

    _showMonocleBorder() {
        const win = this._monocleWin;
        if (!this._monocleBorder || !win) return;
        if (this._monocleGeomSignals && this._monocleGeomSignals.length === 0) {
            const posId = win.connect('position-changed', () => this._positionMonocleBorder(win));
            const sizeId = win.connect('size-changed', () => this._positionMonocleBorder(win));
            this._monocleGeomSignals.push({win, id: posId});
            this._monocleGeomSignals.push({win, id: sizeId});
        }
        this._positionMonocleBorder(win);
        for (const w of Object.values(this._monocleBorder)) w.show();
    }

    _hideMonocleBorder() {
        if (!this._monocleBorder) return;
        for (const w of Object.values(this._monocleBorder)) w.hide();
    }

    _positionMonocleBorder(win) {
        if (!this._monocleBorder || !win || !this._settings) return;
        let rect;
        try { rect = win.get_frame_rect(); } catch (_e) { return; }
        if (!rect) return;
        const {width: w, len} = this._monocleBorderMetrics();
        // El vertice de cada L queda 'w' px por fuera de la esquina (en el gap);
        // los brazos corren 'L' px a lo largo de los bordes. Limitamos L a la
        // mitad de la ventana para que en ventanas pequenas no se crucen.
        const left = rect.x - w;
        const top = rect.y - w;
        const right = rect.x + rect.width + w;
        const bottom = rect.y + rect.height + w;
        const L = Math.max(0, Math.min(len,
            Math.floor(rect.width / 2), Math.floor(rect.height / 2)));
        const b = this._monocleBorder;
        b.tl.set_position(left, top);
        b.tr.set_position(right - L, top);
        b.bl.set_position(left, bottom - L);
        b.br.set_position(right - L, bottom - L);
        for (const w of Object.values(b)) w.set_size(L, L);
        // Mantener las esquinas justo encima del actor de la ventana en
        // monoculo (no en el tope del window_group) por el mismo motivo que el
        // borde de foco: no tapar ventanas flotantes apiladas por encima.
        const actor = win.get_compositor_private();
        for (const widget of Object.values(b)) {
            const parent = widget.get_parent();
            if (parent && parent.set_child_above_sibling) {
                if (actor && actor.get_parent() === parent)
                    parent.set_child_above_sibling(widget, actor);
                else
                    parent.set_child_above_sibling(widget, null);
            }
        }
    }
}
