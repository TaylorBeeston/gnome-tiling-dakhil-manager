import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ACTIVE_STYLE = `
    background-color: rgba(53, 132, 228, 0.95);
    border-radius: 7px;
    color: white;
    font-weight: bold;
    margin: 3px 2px;
    padding: 0 10px;
`;

const INACTIVE_STYLE = `
    background-color: transparent;
    border-radius: 7px;
    color: rgba(255, 255, 255, 0.8);
    margin: 3px 2px;
    padding: 0 10px;
`;

export class SecondaryWorkspacePanel {
    constructor(monitor, connector, count, activate) {
        this._buttons = [];
        this._actor = new St.BoxLayout({
            name: `dwindle-workspace-panel-${connector}`,
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: Main.panel.height,
            style: 'background-color: rgba(24, 24, 27, 0.96);',
        });

        this._actor.add_child(new St.Widget({x_expand: true}));

        for (let index = 0; index < count; index++) {
            const button = new St.Button({
                can_focus: true,
                label: String((index + 1) % 10),
                y_align: Clutter.ActorAlign.FILL,
                style: INACTIVE_STYLE,
            });

            button.connect('clicked', () => activate(index));
            this._actor.add_child(button);
            this._buttons.push(button);
        }

        this._actor.add_child(new St.Widget({x_expand: true}));
        Main.layoutManager.addChrome(this._actor, {
            affectsStruts: true,
            trackFullscreen: true,
        });
    }

    update(activeIndex) {
        this._buttons.forEach((button, index) => {
            button.set_style(index === activeIndex ? ACTIVE_STYLE : INACTIVE_STYLE);
            button.set_checked(index === activeIndex);
        });
    }

    destroy() {
        if (!this._actor) return;

        Main.layoutManager.removeChrome(this._actor);
        this._actor.destroy();
        this._actor = null;
        this._buttons = [];
    }
}
