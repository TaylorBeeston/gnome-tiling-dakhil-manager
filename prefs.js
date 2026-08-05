import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TilingPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const generalPage = new Adw.PreferencesPage({
            title: 'General', icon_name: 'applications-system-symbolic',
        });
        const barPage = new Adw.PreferencesPage({
            title: 'Barra', icon_name: 'view-continuous-symbolic',
        });
        const terminalPage = new Adw.PreferencesPage({
            title: 'Terminal', icon_name: 'utilities-terminal-symbolic',
        });
        const floatPage = new Adw.PreferencesPage({
            title: 'Flotantes', icon_name: 'focus-windows-symbolic',
        });
        const shortcutsPage = new Adw.PreferencesPage({
            title: 'Atajos', icon_name: 'input-keyboard-symbolic',
        });

        const general = new Adw.PreferencesGroup({title: 'General'});
        generalPage.add(general);

        const countRow = new Adw.SpinRow({
            title: 'Numero de workspaces',
            subtitle: 'Workspaces fijos (1-10). Cambiar este valor actualiza num-workspaces al instante, pero para que se actualicen los atajos Super+N hay que desactivar y reactivar la extension.',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 10, step_increment: 1, page_increment: 1,
            }),
        });
        settings.bind('workspace-count', countRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(countRow);
        const localWorkspacesRow = new Adw.SwitchRow({
            title: 'Workspaces locales por monitor',
            subtitle: 'Super+N cambia solamente el monitor que tiene el foco. Cada monitor conserva su propio workspace 1-10.',
        });
        settings.bind('monitor-local-workspaces', localWorkspacesRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(localWorkspacesRow);

        const enabledRow = new Adw.SwitchRow({
            title: 'Tiling automatico',
            subtitle: 'Acomoda las ventanas en dwindle (BSP) al abrirlas',
        });
        settings.bind('tiling-enabled', enabledRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(enabledRow);

        const strictRow = new Adw.SwitchRow({
            title: 'Modo estricto',
            subtitle: 'Ventanas tiled vuelven a su geometria si las arrastras o redimensionas. Solo se pueden mover/redimensionar libremente las ventanas en modo flotante (Super+V).',
        });
        settings.bind('strict-tiling', strictRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(strictRow);

        const disableNativeRow = new Adw.SwitchRow({
            title: 'Desactivar manejo nativo de GNOME',
            subtitle: 'Apaga edge-tiling, auto-maximize y los atajos Super+Up/Down/Left/Right (maximize/snap a mitades) mientras la extension este activa. Cambios requieren desactivar y reactivar la extension.',
        });
        settings.bind('disable-native-window-management', disableNativeRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(disableNativeRow);

        const warpPointerRow = new Adw.SwitchRow({
            title: 'Cursor sigue al foco',
            subtitle: 'Mueve el puntero al centro de la ventana al cambiar de foco direccional o moverla de monitor.',
        });
        settings.bind('warp-pointer-on-focus', warpPointerRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(warpPointerRow);

        const focusFollowsMouseRow = new Adw.SwitchRow({
            title: 'El foco sigue al raton',
            subtitle: 'Activa el modo sloppy de GNOME: al pasar el puntero sobre una ventana recibe el foco sin clic. Al desactivarlo se restaura tu ajuste original de GNOME.',
        });
        settings.bind('focus-follows-mouse', focusFollowsMouseRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(focusFollowsMouseRow);

        const borderGroup = new Adw.PreferencesGroup({title: 'Borde de focus'});
        generalPage.add(borderGroup);

        const borderEnabledRow = new Adw.SwitchRow({
            title: 'Mostrar borde',
            subtitle: 'Dibuja un borde de color alrededor de la ventana con focus',
        });
        settings.bind('focus-border-enabled', borderEnabledRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        borderGroup.add(borderEnabledRow);

        const borderWidthRow = new Adw.SpinRow({
            title: 'Grosor (px)',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 20, step_increment: 1, page_increment: 2,
            }),
        });
        settings.bind('focus-border-width', borderWidthRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        borderGroup.add(borderWidthRow);

        const borderColorRow = new Adw.EntryRow({
            title: 'Color (hex o nombre CSS)',
        });
        settings.bind('focus-border-color', borderColorRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        borderGroup.add(borderColorRow);

        const gapRow = new Adw.SpinRow({
            title: 'Gap (px)',
            subtitle: 'Espacio entre ventanas y bordes',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 100, step_increment: 1, page_increment: 4,
            }),
        });
        settings.bind('gap-size', gapRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(gapRow);

        const resizeStepRow = new Adw.SpinRow({
            title: 'Paso de resize (px)',
            subtitle: 'Pixeles que se mueve el borde con Super+Ctrl+Flecha',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 200, step_increment: 1, page_increment: 10,
            }),
        });
        settings.bind('resize-step-px', resizeStepRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(resizeStepRow);
        const animationGroup = new Adw.PreferencesGroup({
            title: 'Animaciones',
        });
        generalPage.add(animationGroup);

        const animationsEnabledRow = new Adw.SwitchRow({
            title: 'Animar mosaico',
            subtitle: 'Suaviza aperturas, cierres, swaps y cambios de tamano.',
        });
        settings.bind('animations-enabled', animationsEnabledRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        animationGroup.add(animationsEnabledRow);

        const animationDurationRow = new Adw.SpinRow({
            title: 'Duracion del mosaico (ms)',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1000, step_increment: 10, page_increment: 50,
            }),
        });
        settings.bind('animation-duration-ms', animationDurationRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        animationGroup.add(animationDurationRow);

        const workspaceAnimationsRow = new Adw.SwitchRow({
            title: 'Animar workspaces locales',
            subtitle: 'Desliza solamente el monitor que cambia de workspace.',
        });
        settings.bind('workspace-animations-enabled', workspaceAnimationsRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        animationGroup.add(workspaceAnimationsRow);

        const workspaceAnimationDurationRow = new Adw.SpinRow({
            title: 'Duracion de workspace (ms)',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1000, step_increment: 10, page_increment: 50,
            }),
        });
        settings.bind(
            'workspace-animation-duration-ms',
            workspaceAnimationDurationRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        animationGroup.add(workspaceAnimationDurationRow);

        const animationExclusionsRow = new Adw.EntryRow({
            title: 'Apps sin animacion',
            text: settings.get_strv('animation-disabled-classes').join(', '),
        });
        animationExclusionsRow.connect('changed', () => {
            settings.set_strv(
                'animation-disabled-classes',
                animationExclusionsRow.text
                    .split(',')
                    .map(value => value.trim())
                    .filter(Boolean)
            );
        });
        animationGroup.add(animationExclusionsRow);


        const terminalGroup = new Adw.PreferencesGroup({
            title: 'Terminal',
            description: 'Comando que ejecuta Super+Enter. Tiene que existir en $PATH. Ejemplos: ghostty, kgx, gnome-terminal, alacritty, kitty, foot, konsole, xterm, "ptyxis --new-window".',
        });
        terminalPage.add(terminalGroup);

        const termRow = new Adw.EntryRow({title: 'Comando de terminal'});
        settings.bind('terminal-command', termRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        terminalGroup.add(termRow);

        const knownTerminals = [
            'ghostty', 'kgx', 'gnome-terminal', 'ptyxis --new-window',
            'alacritty', 'kitty', 'foot', 'konsole', 'wezterm', 'xterm',
        ];
        const detectedRow = new Adw.ExpanderRow({
            title: 'Terminales detectadas',
            subtitle: 'Pulsa una para configurarla',
        });
        let anyDetected = false;
        for (const t of knownTerminals) {
            const bin = t.split(' ')[0];
            if (GLib.find_program_in_path(bin)) {
                anyDetected = true;
                const row = new Adw.ActionRow({title: t});
                const btn = new Gtk.Button({
                    label: 'Usar',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                btn.connect('clicked', () => {
                    settings.set_string('terminal-command', t);
                });
                row.add_suffix(btn);
                row.activatable_widget = btn;
                detectedRow.add_row(row);
            }
        }
        if (anyDetected) terminalGroup.add(detectedRow);

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Barra superior',
            description: 'Ajustes de la barra superior de GNOME.',
        });
        barPage.add(panelGroup);

        const spacingRow = new Adw.SpinRow({
            title: 'Separacion entre indicadores (px)',
            subtitle: '-1 = dejar la separacion por defecto de GNOME',
            adjustment: new Gtk.Adjustment({
                lower: -1, upper: 40, step_increment: 1, page_increment: 4,
            }),
        });
        settings.bind('panel-spacing', spacingRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(spacingRow);

        const focusedAppRow = new Adw.SwitchRow({
            title: 'Mostrar app con foco',
            subtitle: 'Muestra el nombre de la app con foco en la barra (a la izquierda).',
        });
        settings.bind('panel-show-focused-app', focusedAppRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(focusedAppRow);

        const floatGroup = new Adw.PreferencesGroup({
            title: 'Aplicaciones flotantes',
            description: 'Marca las apps que quieres que abran en modo flotante. Si no aparece tu app o quieres agregar un WM_CLASS manual, usa dconf-editor en /org/gnome/shell/extensions/dwindle/. Tambien puedes alternar al vuelo con Super+V.',
        });
        floatPage.add(floatGroup);

        const search = new Gtk.SearchEntry({
            placeholder_text: 'Buscar aplicacion...',
            hexpand: true,
        });

        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
        });

        const scrolled = new Gtk.ScrolledWindow({
            height_request: 320,
            child: listBox,
            hexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8,
        });
        box.append(search);
        box.append(scrolled);

        const floatRow = new Adw.PreferencesRow({
            activatable: false,
            child: box,
        });
        floatGroup.add(floatRow);

        const rowData = new Map();

        const guessWmClass = app => {
            try {
                const fromDesktop = app.get_startup_wm_class && app.get_startup_wm_class();
                if (fromDesktop) return fromDesktop;
            } catch (_e) {}
            const id = app.get_id() || '';
            return id.replace(/\.desktop$/, '');
        };

        const apps = Gio.AppInfo.get_all()
            .filter(app => app.should_show())
            .map(app => ({
                app,
                name: app.get_display_name() || app.get_name() || '',
                wmClass: guessWmClass(app),
                icon: app.get_icon(),
            }))
            .filter(d => d.name && d.wmClass)
            .sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));

        const currentSet = () => new Set(settings.get_strv('floating-window-classes'));
        let active = currentSet();

        const rows = [];
        for (const {name, wmClass, icon} of apps) {
            const row = new Adw.ActionRow({title: name, subtitle: wmClass});
            if (icon) {
                const img = new Gtk.Image({gicon: icon, pixel_size: 28});
                row.add_prefix(img);
            }
            const check = new Gtk.CheckButton({
                active: active.has(wmClass),
                valign: Gtk.Align.CENTER,
            });
            check.connect('toggled', () => {
                const list = currentSet();
                if (check.active) list.add(wmClass);
                else list.delete(wmClass);
                settings.set_strv('floating-window-classes', [...list].sort());
            });
            row.add_suffix(check);
            row.activatable_widget = check;
            listBox.append(row);
            rowData.set(row, {name, wmClass, check});
            rows.push(row);
        }

        listBox.set_filter_func(row => {
            const q = search.text.toLowerCase().trim();
            if (!q) return true;
            const d = rowData.get(row);
            if (!d) return false;
            return d.name.toLowerCase().includes(q)
                || d.wmClass.toLowerCase().includes(q);
        });
        search.connect('search-changed', () => listBox.invalidate_filter());

        const manualGroup = new Adw.PreferencesGroup({
            title: 'Entradas manuales',
            description: 'Agrega un WM_CLASS que no aparezca en la lista de apps de arriba. Util cuando el StartupWMClass del .desktop no coincide con el class real (descubrelo con Super+I sobre la ventana).',
        });
        floatPage.add(manualGroup);

        const manualEntry = new Adw.EntryRow({
            title: 'Nuevo WM_CLASS',
            show_apply_button: true,
        });
        manualGroup.add(manualEntry);

        const appClassSet = new Set(apps.map(a => a.wmClass));
        let manualRows = [];

        const refreshManualList = () => {
            for (const r of manualRows) manualGroup.remove(r);
            manualRows = [];
            const current = settings.get_strv('floating-window-classes').slice().sort();
            for (const cls of current) {
                if (appClassSet.has(cls)) continue;
                const row = new Adw.ActionRow({title: cls, subtitle: 'Entrada manual'});
                const btn = new Gtk.Button({
                    icon_name: 'edit-delete-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                btn.connect('clicked', () => {
                    const list = new Set(settings.get_strv('floating-window-classes'));
                    list.delete(cls);
                    settings.set_strv('floating-window-classes', [...list].sort());
                });
                row.add_suffix(btn);
                manualGroup.add(row);
                manualRows.push(row);
            }
        };
        refreshManualList();

        manualEntry.connect('apply', () => {
            const cls = manualEntry.text.trim();
            if (!cls) return;
            const list = new Set(settings.get_strv('floating-window-classes'));
            if (!list.has(cls)) {
                list.add(cls);
                settings.set_strv('floating-window-classes', [...list].sort());
            }
            manualEntry.text = '';
        });

        const settingsListId = settings.connect('changed::floating-window-classes', () => {
            const want = currentSet();
            for (const [, d] of rowData) {
                const should = want.has(d.wmClass);
                if (d.check.active !== should)
                    d.check.active = should;
            }
            refreshManualList();
        });
        window.connect('close-request', () => {
            settings.disconnect(settingsListId);
            return false;
        });

        const shortcutChangedIds = [];
        const isModifierKeyval = (keyval) => [
            Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
            Gdk.KEY_Control_L, Gdk.KEY_Control_R,
            Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
            Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
            Gdk.KEY_Super_L, Gdk.KEY_Super_R,
            Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
            Gdk.KEY_ISO_Level3_Shift,
        ].includes(keyval);

        const captureShortcut = (key, title, onDone) => {
            const dialog = new Adw.Window({
                modal: true,
                transient_for: window,
                default_width: 420,
                default_height: 180,
                title: 'Nuevo atajo',
            });
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 12, valign: Gtk.Align.CENTER,
                margin_top: 24, margin_bottom: 24, margin_start: 24, margin_end: 24,
            });
            box.append(new Gtk.Label({
                label: `Pulsa la nueva combinacion para\n<b>${GLib.markup_escape_text(title, -1)}</b>`,
                use_markup: true, justify: Gtk.Justification.CENTER,
            }));
            box.append(new Gtk.Label({
                label: 'Esc cancela · Retroceso borra el atajo',
                css_classes: ['dim-label', 'caption'],
            }));
            dialog.set_content(box);

            const controller = new Gtk.EventControllerKey();
            controller.connect('key-pressed', (_c, keyval, keycode, state) => {
                let mask = state & Gtk.accelerator_get_default_mod_mask();
                mask &= ~Gdk.ModifierType.LOCK_MASK;

                if (keyval === Gdk.KEY_Escape && mask === 0) {
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if ((keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) && mask === 0) {
                    settings.set_strv(key, []);
                    onDone();
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (isModifierKeyval(keyval)) return Gdk.EVENT_STOP;

                const isFn = keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F12;
                if (mask === 0 && !isFn) return Gdk.EVENT_STOP;
                if (!Gtk.accelerator_valid(keyval, mask)) return Gdk.EVENT_STOP;

                const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
                settings.set_strv(key, [accel]);
                onDone();
                dialog.close();
                return Gdk.EVENT_STOP;
            });
            dialog.add_controller(controller);
            dialog.present();
        };

        const makeShortcutRow = (group, key, title) => {
            const row = new Adw.ActionRow({title, activatable: true});
            const label = new Gtk.Label({
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.END,
                css_classes: ['dim-label'],
            });
            const editBtn = new Gtk.Button({
                icon_name: 'document-edit-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: 'Editar atajo',
            });
            const sync = () => {
                const accels = settings.get_strv(key);
                if (!accels.length) {
                    label.label = 'Sin asignar';
                    return;
                }
                const [ok, keyval, mods] = Gtk.accelerator_parse(accels[0]);
                label.label = ok ? Gtk.accelerator_get_label(keyval, mods) : accels[0];
            };
            const open = () => captureShortcut(key, title, sync);
            editBtn.connect('clicked', open);
            row.connect('activated', open);
            row.add_suffix(label);
            row.add_suffix(editBtn);
            sync();
            shortcutChangedIds.push(settings.connect(`changed::${key}`, sync));
            group.add(row);
        };

        const shortcutGroups = [
            ['Foco', [
                ['focus-left', 'Foco a la izquierda'],
                ['focus-right', 'Foco a la derecha'],
                ['focus-up', 'Foco arriba'],
                ['focus-down', 'Foco abajo'],
            ]],
            ['Mover / intercambiar ventana', [
                ['move-window-left', 'Intercambiar con la izquierda'],
                ['move-window-right', 'Intercambiar con la derecha'],
                ['move-window-up', 'Intercambiar con la de arriba'],
                ['move-window-down', 'Intercambiar con la de abajo'],
            ]],
            ['Monitores', [
                ['window-to-monitor-left', 'Mover al monitor izquierdo'],
                ['window-to-monitor-right', 'Mover al monitor derecho'],
                ['window-to-monitor-up', 'Mover al monitor de arriba'],
                ['window-to-monitor-down', 'Mover al monitor de abajo'],
            ]],
            ['Redimensionar', [
                ['resize-left', 'Borde a la izquierda'],
                ['resize-right', 'Borde a la derecha'],
                ['resize-up', 'Borde arriba'],
                ['resize-down', 'Borde abajo'],
                ['rotate-split', 'Rotar split (vertical/horizontal)'],
            ]],
            ['Acciones', [
                ['open-terminal', 'Abrir terminal'],
                ['screenshot-region', 'Capturar region en Swappy'],
                ['toggle-monocle', 'Monoculo (ver solo la ventana con foco)'],
                ['toggle-tiling', 'Activar/desactivar tiling'],
                ['toggle-floating', 'Alternar tiled/floating'],
                ['float-next-window', 'La proxima ventana se abre flotante'],
                ['close-window', 'Cerrar ventana'],
                ['toggle-decoration', 'Ocultar/mostrar titlebar'],
                ['show-focused-info', 'Mostrar WM_CLASS de la ventana'],
                ['show-help', 'Mostrar modal de ayuda'],
            ]],
        ];

        for (const [groupTitle, binds] of shortcutGroups) {
            const group = new Adw.PreferencesGroup({title: groupTitle});
            shortcutsPage.add(group);
            for (const [key, title] of binds)
                makeShortcutRow(group, key, title);
        }

        const switchWsGroup = new Adw.PreferencesGroup({
            title: 'Cambiar workspace local',
            description: 'Super+N cambia solamente el monitor que tiene el foco.',
        });
        shortcutsPage.add(switchWsGroup);

        const moveWsGroup = new Adw.PreferencesGroup({
            title: 'Mover ventana a workspace local',
        });
        shortcutsPage.add(moveWsGroup);

        const wsCount = settings.get_int('workspace-count');
        for (let i = 1; i <= wsCount; i++) {
            makeShortcutRow(switchWsGroup, `switch-local-workspace-${i}`, `Cambiar al workspace ${i}`);
            makeShortcutRow(moveWsGroup, `move-window-to-workspace-${i}`, `Mover al workspace ${i}`);
        }

        window.connect('close-request', () => {
            for (const id of shortcutChangedIds) {
                try { settings.disconnect(id); } catch (_e) {}
            }
            return false;
        });

        window.add(generalPage);
        window.add(barPage);
        window.add(terminalPage);
        window.add(floatPage);
        window.add(shortcutsPage);
    }
}
