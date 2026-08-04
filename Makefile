UUID         = dwindle@taylorbeeston
INSTALL_DIR  = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCE_DIR   = $(CURDIR)
SCHEMA_DIR   = $(SOURCE_DIR)/schemas

.PHONY: all build install uninstall reinstall enable disable status pack clean help

all: build

help:
	@echo "Targets:"
	@echo "  build      - Compile GSettings schemas (default)"
	@echo "  install    - Symlink this directory into ~/.local/share/gnome-shell/extensions/"
	@echo "  uninstall  - Disable and remove the install"
	@echo "  reinstall  - Uninstall + install"
	@echo "  enable     - gnome-extensions enable $(UUID)"
	@echo "  disable    - gnome-extensions disable $(UUID)"
	@echo "  status     - Show extension info"
	@echo "  pack       - Build a zip ready for extensions.gnome.org"
	@echo "  clean      - Remove build artifacts"

build:
	@glib-compile-schemas "$(SCHEMA_DIR)/"
	@echo "Schemas compiled."

install: build
	@if [ -e "$(INSTALL_DIR)" ] && [ ! -L "$(INSTALL_DIR)" ]; then \
		echo "ERROR: $(INSTALL_DIR) exists and is not a symlink."; \
		echo "Run 'make uninstall' first (this will remove the existing install)."; \
		exit 1; \
	fi
	@ln -sfn "$(SOURCE_DIR)" "$(INSTALL_DIR)"
	@echo "Linked: $(INSTALL_DIR) -> $(SOURCE_DIR)"
	@echo "Next: log out and back in (Wayland), then 'make enable'."

uninstall:
	@-gnome-extensions disable $(UUID) 2>/dev/null
	@rm -rf "$(INSTALL_DIR)"
	@echo "Removed: $(INSTALL_DIR)"

reinstall: uninstall install

enable:
	@gnome-extensions enable $(UUID)
	@gnome-extensions info $(UUID) | grep -E "Name|Enabled|State"

disable:
	@gnome-extensions disable $(UUID)

status:
	@gnome-extensions info $(UUID) 2>/dev/null || echo "Not installed."

pack: build
	@cd "$(SOURCE_DIR)" && zip -r "$(UUID).zip" \
		metadata.json extension.js prefs.js animationMath.js workspaceMath.js schemas/ \
		-x 'schemas/gschemas.compiled' \
		>/dev/null
	@echo "Built: $(SOURCE_DIR)/$(UUID).zip"

clean:
	@rm -f "$(SCHEMA_DIR)/gschemas.compiled"
	@rm -f "$(SOURCE_DIR)/$(UUID).zip"
	@echo "Cleaned."
