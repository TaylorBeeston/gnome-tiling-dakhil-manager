import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DwindleLoader extends Extension {
    async enable() {
        const sequence = (this._reloadSequence ?? 0) + 1;

        this._reloadSequence = sequence;

        const {default: DwindleRuntime} =
            await import(`./runtime.js?reload=${sequence}`);
        const runtime = new DwindleRuntime(this.metadata);

        this._runtime = runtime;

        try {
            await runtime.enable();
        } catch (error) {
            this._runtime = null;

            try { runtime.disable(); } catch (_disableError) {}

            throw error;
        }

        console.info(`[Dwindle] Loaded runtime revision ${sequence}`);
    }

    disable() {
        const runtime = this._runtime;

        this._runtime = null;
        runtime?.disable();
    }
}
