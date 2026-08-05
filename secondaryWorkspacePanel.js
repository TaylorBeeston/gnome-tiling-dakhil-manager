import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
const PANEL_HEIGHT = 32;
const DEFAULT_SPACING = 8;
const PANEL_STYLE = `
    background-color: rgba(24, 24, 28, 0.96);
    border-radius: 7px;
    color: #cdd6f4;
    font-size: 13px;
`;
const ACTIVE_WORKSPACE_STYLE = `
    color: #89b4fa;
    font-weight: bold;
    padding: 0 5px;
`;
const INACTIVE_WORKSPACE_STYLE = `
    color: #cba6f7;
    padding: 0 5px;
`;

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);

        if (!ok) return null;

        return new TextDecoder().decode(bytes).trim();
    } catch (_error) {
        return null;
    }
}

function formatClock() {
    const now = GLib.DateTime.new_now_local();
    const time = now.format('%I:%M %p').replace(/^0/, '');

    return `${now.format('%a %b')} ${now.get_day_of_month()}  ${time}`;
}

function discoverCpuTemperaturePath() {
    try {
        const directory = Gio.File.new_for_path('/sys/class/hwmon');
        const files = directory.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        let info;

        while ((info = files.next_file(null))) {
            const path = `/sys/class/hwmon/${info.get_name()}`;
            const name = readText(`${path}/name`);

            if (name !== 'coretemp' && name !== 'k10temp') continue;

            for (let index = 1; index <= 16; index++) {
                const input = `${path}/temp${index}_input`;
                const label = readText(`${path}/temp${index}_label`);

                if (label === 'Package id 0' || label === 'Tctl') {
                    files.close(null);
                    return input;
                }
            }

            if (readText(`${path}/temp1_input`)) {
                files.close(null);
                return `${path}/temp1_input`;
            }
        }

        files.close(null);
    } catch (_error) {
        return null;
    }

    return null;
}

class MetricsSampler {
    constructor() {
        this._subscribers = new Set();
        this._timerId = 0;
        this._cpuSnapshot = null;
        this._cpuTemperaturePath = discoverCpuTemperaturePath();
        this._gpuQueryPending = false;
        this._metrics = {
            cpu: null,
            cpuTemperature: null,
            gpu: null,
            gpuTemperature: null,
            gpuPower: null,
            memory: null,
        };
    }

    subscribe(callback) {
        this._subscribers.add(callback);
        callback(this._metrics);

        if (this._subscribers.size === 1) this._start();

        return () => {
            this._subscribers.delete(callback);

            if (this._subscribers.size === 0) this._stop();
        };
    }

    _start() {
        this._sample();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            2,
            () => {
                this._sample();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stop() {
        if (this._timerId) GLib.source_remove(this._timerId);

        this._timerId = 0;
    }

    _sample() {
        this._sampleCpu();
        this._sampleMemory();
        this._sampleTemperature();
        this._sampleGpu();
        this._publish();
    }

    _sampleCpu() {
        const line = readText('/proc/stat')?.split('\n')[0];

        if (!line?.startsWith('cpu ')) return;

        const values = line.trim().split(/\s+/).slice(1).map(Number);
        const snapshot = {
            idle: (values[3] || 0) + (values[4] || 0),
            total: values.reduce((sum, value) => sum + value, 0),
        };

        if (this._cpuSnapshot) {
            const idle = snapshot.idle - this._cpuSnapshot.idle;
            const total = snapshot.total - this._cpuSnapshot.total;

            if (total > 0)
                this._metrics.cpu = Math.round(100 * (1 - idle / total));
        }

        this._cpuSnapshot = snapshot;
    }

    _sampleMemory() {
        const values = Object.fromEntries(
            (readText('/proc/meminfo') || '')
                .split('\n')
                .map(line => line.match(/^(MemTotal|MemAvailable):\s+(\d+)/))
                .filter(Boolean)
                .map(match => [match[1], Number(match[2])])
        );

        if (values.MemTotal)
            this._metrics.memory = Math.round(
                100 * (1 - values.MemAvailable / values.MemTotal)
            );
    }

    _sampleTemperature() {
        if (!this._cpuTemperaturePath) return;

        const value = Number(readText(this._cpuTemperaturePath));

        if (Number.isFinite(value))
            this._metrics.cpuTemperature = Math.round(value / 1000);
    }

    _sampleGpu() {
        if (this._gpuQueryPending) return;

        this._gpuQueryPending = true;

        try {
            const process = Gio.Subprocess.new([
                'nvidia-smi',
                '--query-gpu=utilization.gpu,temperature.gpu,power.draw',
                '--format=csv,noheader,nounits',
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);

            process.communicate_utf8_async(null, null, (source, result) => {
                this._gpuQueryPending = false;

                try {
                    const [, stdout] = source.communicate_utf8_finish(result);
                    const [gpu, temperature, power] = stdout
                        .trim()
                        .split(',')
                        .map(Number);

                    if (Number.isFinite(gpu)) this._metrics.gpu = Math.round(gpu);
                    if (Number.isFinite(temperature))
                        this._metrics.gpuTemperature = Math.round(temperature);
                    if (Number.isFinite(power))
                        this._metrics.gpuPower = Math.round(power);

                    this._publish();
                } catch (_error) {
                    // Keep the last successful reading.
                }
            });
        } catch (_error) {
            this._gpuQueryPending = false;
        }
    }

    _publish() {
        for (const callback of this._subscribers) callback(this._metrics);
    }
}

const metricsSampler = new MetricsSampler();

class ClockView {
    constructor() {
        this.actor = new St.Label({
            text: formatClock(),
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: #f9e2af; font-weight: bold; padding: 0 5px;',
        });
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            () => {
                this.actor.text = formatClock();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    destroy() {
        if (this._timerId) GLib.source_remove(this._timerId);

        this._timerId = 0;
        this.actor.destroy();
    }
}

class WorkspaceView {
    constructor(count, activate) {
        this.actor = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._buttons = [];

        for (let index = 0; index < count; index++) {
            const button = new St.Button({
                can_focus: true,
                label: String((index + 1) % 10),
                style: INACTIVE_WORKSPACE_STYLE,
            });

            button.connect('clicked', () => activate(index));
            this.actor.add_child(button);
            this._buttons.push(button);
        }
    }

    update(activeIndex) {
        this._buttons.forEach((button, index) => {
            button.set_checked(index === activeIndex);
            button.set_style(index === activeIndex
                ? ACTIVE_WORKSPACE_STYLE
                : INACTIVE_WORKSPACE_STYLE);
        });
    }

    destroy() {
        this.actor.destroy();
        this._buttons = [];
    }
}

class MetricsView {
    constructor() {
        this.actor = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._cpu = this._addLabel('#89b4fa');
        this._gpu = this._addLabel('#a6e3a1');
        this._memory = this._addLabel('#cba6f7');
        this._temperature = this._addLabel('#fab387');
        this._unsubscribe = metricsSampler.subscribe(metrics => this._update(metrics));
    }

    _addLabel(color) {
        const label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: `color: ${color}; font-feature-settings: "tnum"; padding: 0 4px;`,
        });

        this.actor.add_child(label);
        return label;
    }

    _update(metrics) {
        this._cpu.text = `CPU ${metrics.cpu ?? '--'}%`;
        this._gpu.text = `GPU ${metrics.gpu ?? '--'}% ${metrics.gpuPower ?? '--'}W`;
        this._memory.text = `RAM ${metrics.memory ?? '--'}%`;
        this._temperature.text = `TEMP ${metrics.cpuTemperature ?? '--'}° ${metrics.gpuTemperature ?? '--'}°`;
    }

    setSpacing(spacing) {
        this.actor.set_style(`spacing: ${spacing}px; padding-right: 8px;`);
    }

    destroy() {
        this._unsubscribe?.();
        this._unsubscribe = null;
        this.actor.destroy();
    }
}

class BarContent {
    constructor(count, activate, spacing) {
        this.left = new St.BoxLayout({
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.title = new St.Label({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: #f5c2e7; font-weight: bold; padding: 0 12px;',
        });
        this.metrics = new MetricsView();
        this.workspaces = new WorkspaceView(count, activate);
        this.clock = new ClockView();

        this.left.add_child(this.workspaces.actor);
        this.left.add_child(this.clock.actor);
        this.setSpacing(spacing);
    }

    update(activeIndex, title, showTitle = true) {
        this.workspaces.update(activeIndex);
        this.title.text = showTitle ? title : '';
        this.title.visible = showTitle && !!title;
    }

    setSpacing(spacing) {
        const px = spacing < 0 ? DEFAULT_SPACING : spacing;

        this.left.set_style(`spacing: ${px}px; padding-left: 8px;`);
        this.metrics.setSpacing(Math.max(0, Math.floor(px / 2)));
    }

    destroy() {
        this.workspaces.destroy();
        this.clock.destroy();
        this.metrics.destroy();
        this.title.destroy();
        this.left.destroy();
    }
}

export class PrimarySystemBar {
    constructor(count, activate, spacing) {
        this._content = new BarContent(count, activate, spacing);
        this._nativeLeftChildren = Main.panel._leftBox.get_children();
        this._nativeCenterChildren = Main.panel._centerBox.get_children();

        for (const child of this._nativeLeftChildren) child.hide();
        for (const child of this._nativeCenterChildren) child.hide();
        this._titleButton =
            new PanelMenu.Button(0.0, 'DwindleActiveWindow', true);
        this._titleButton.add_child(this._content.title);

        Main.panel._leftBox.insert_child_at_index(this._content.left, 0);
        Main.panel.addToStatusArea(
            'dwindleActiveWindow',
            this._titleButton,
            0,
            'center'
        );
        Main.panel._rightBox.insert_child_at_index(this._content.metrics.actor, 0);
    }

    update(activeIndex, title, showTitle) {
        this._content.update(activeIndex, title, showTitle);
    }

    setSpacing(spacing) {
        this._content.setSpacing(spacing);
    }

    destroy() {
        this._content.destroy();
        this._titleButton.destroy();

        for (const child of this._nativeLeftChildren) child.show();
        for (const child of this._nativeCenterChildren) child.show();

        this._nativeLeftChildren = [];
        this._nativeCenterChildren = [];
        this._titleButton = null;
        this._content = null;
    }
}

export class SecondarySystemBar {
    constructor(monitor, _connector, count, activate, spacing) {
        this._content = new BarContent(count, activate, spacing);
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            style: PANEL_STYLE,
        });
        this._content.left.x_expand = true;
        this._right = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._right.add_child(this._content.metrics.actor);
        this._actor.add_child(this._content.left);
        this._actor.add_child(this._content.title);
        this._actor.add_child(this._right);
        this._actor.set_position(monitor.x, monitor.y);
        this._actor.set_size(monitor.width, PANEL_HEIGHT);

        Main.layoutManager.addChrome(this._actor, {
            affectsStruts: true,
            trackFullscreen: true,
        });
    }

    update(activeIndex, title, showTitle) {
        this._content.update(activeIndex, title, showTitle);
    }

    setSpacing(spacing) {
        this._content.setSpacing(spacing);
    }

    destroy() {
        if (!this._actor) return;

        Main.layoutManager.removeChrome(this._actor);
        this._content.destroy();
        this._right.destroy();
        this._actor.destroy();
        this._content = null;
        this._right = null;
        this._actor = null;
    }
}
