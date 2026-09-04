<div align="center">

<img src="docs/images/logo.svg" alt="Uartix+" width="88" />

# Uartix+

### A visual host-computer suite for embedded systems

Define protocols by drag-and-drop · Parse and visualise in real time · Debug in a closed loop

*嵌入式可视化上位机 —— 见 [中文 README](README.md)*

<br/>

[![Release][badge-rel]][get-it]
[![Download][badge-dl]][get-it]
[![License][badge-li]][license]
[![Platform][badge-pf]][get-it]
[![Tauri][badge-ta]][tauri]

<br/>

**[Download](#download)** · **[Quick start](#quick-start)** · **[Website][website]** · **[中文](README.md)**

</div>

![Uartix+ main window: templates, frame canvas, properties, 2D plot, data table and control canvas. The interface switches to English in one click.](docs/images/overview.png)

---

## What it is

Uartix+ is a **host computer** that runs on your PC. Downward it talks to MCUs, IMUs, gimbots and robots; upward it turns raw bytes into structure, numbers, curves and pictures, then writes your actions back as commands the device accepts.

It is far more than a serial terminal that echoes characters. **Protocols need no parser code** — select bytes on the stream and the frame layout and field meaning follow. **Interfaces need no UI code** — drag widgets together into a bench of your own. Connecting, checksums, measurement, visualisation, scripting and export close the loop in one place.

| | Serial terminal | Waveform viewer | **Uartix+** |
|---|:---:|:---:|:---:|
| Send and receive raw data | ✅ | partial | ✅ |
| Custom binary protocol parsing | hard-coded or scripted | fixed format expected | **drag to define, zero code** |
| Frame structure visualisation | ❌ | ❌ | **byte-level colour canvas** |
| Send control commands | manual typing | basic widgets | **widgets + frame factory + scripts** |
| Frame table and export | ❌ | ❌ | ✅ |
| Dual-cursor / pointer readout | ❌ | basic | **time ruler + amplitude ruler** |
| Video link beside telemetry | ❌ | ❌ | ✅ |
| AI-generated components and actions | ❌ | ❌ | **built in (since v0.3.6)** |

---

## Capabilities

### Protocol parsing engine

Select a run of bytes on the Hex stream, right-click and declare it as header, length field, discriminator, payload or checksum; field width grows with the type you pick. A frame header alone rarely tells frame types apart, so parsing uses two-stage recognition: any field can act as a discriminator matched against a multi-byte function code, and several templates parse the same stream in parallel without interfering.

<details>
<summary><b>Technical details</b> (checksums / field types / text streams / presets)</summary>

- **Checksums**: Sum8 / XOR8 / CRC16-Modbus / CRC16-CCITT / CRC32, with negative offsets so trailing checksum bytes can be excluded
- **Field types**: u8 / i8 / u16 / i16 / u32 / i32 / f32 / f64, plus ASCII / BCD / bit-field; endianness switchable, scale and bias apply instantly
- **Text streams are protocols too**: the header may be empty, channels are split adaptively on the delimiter, and the channel count follows each frame's segment count
- **Preset templates**: WitMotion JY901, Anonymous V7, Modbus, CSV text stream; any protocol exports to JSON for sharing
- **Clusters**: one protocol per tab holding many frame types, with right-click copy / paste / rename / export

</details>

### Visualisation

Parsed fields register as variables automatically — click the eye on a legend entry to plot it. The 2D plot carries two independent cursors (time and amplitude) for A−B delta measurement, and the crosshair snaps to the nearest curve to show raw readings. Peak/valley-preserving decimation keeps long captures smooth while cursors, tables and exports always work on the full dataset.

<details>
<summary><b>Per-panel details</b> (2D plot / 3D attitude / video link / frame canvas / table / console)</summary>

- **2D plot**: line / step / spline, relative-seconds axis (0s / 60s / 1.2h), newest-value marker anchored to the real curve end, continuous Y auto-fit plus a one-shot Auto button
- **3D attitude**: Euler or quaternion input, six rotation orders and per-axis inversion, quadcopter and cube models, fields bindable across protocol templates
- **Video link**: renders frames as pictures in real time from a network source, with pause / rewind / save frame / mirror / flip
- **Frame canvas**: per-byte colouring, hover for attributes, right-click to insert or delete cells, and a "no valid frame yet" badge with a four-step checklist
- **Data table**: virtualised list, sorting and filtering, CSV / Excel export
- **Console**: Hex / ASCII / timestamp views, colour-coded RX and TX
- **Demo source**: exercise every feature with no hardware attached

</details>

### Downstream control

The control canvas turns debugging panels into a drag-and-drop exercise: a ghost preview shows where a card will land, collision detection and nearest-snap guarantee cards never overlap. The frame factory handles visual message assembly, so "which bytes do I send" stops being a hexadecimal typing exercise.

<details>
<summary><b>Widgets and commands</b> (canvas / keyboard remote / frame factory / scripts)</summary>

- **Widgets**: slider / button / switch / multi-position switch / LED / value monitor / buzzer / joystick, with copy-paste and grid alignment
- **Keyboard remote**: cards locked to an n×n grid, mapping physical keys to commands; script mode can branch per direction
- **Frame factory**: built-in WIT register writes (unlock → write → save automatically), Anonymous V7 triggers and parameter access, Modbus RTU, checksum tools; "My protocols" lets you build frame templates with live per-segment preview
- **Quick command bar**: command chips fire on click, hover to preview the exact bytes
- **Scripts and variables**: C-like scripts, parsed fields become variables automatically, `%x` placeholders in templates, `send` / `beep` / `delay_ms` available

</details>

### Connectivity and performance

Interfaces cover serial / TCP client / TCP server / UDP, all sharing one parsing pipeline, so network sources get the full feature set. A unplugged serial port is detected within two seconds and reconnects on replug; network drops reconnect automatically.

<details>
<summary><b>Engineering details</b> (performance / layout / themes / updates)</summary>

- **Binary IPC**: frames travel over a Tauri Channel as ArrayBuffer, skipping base64 and JSON overhead
- **Panel lifecycle gating**: closed panels stop moving data; background tabs in a stack buffer without rendering
- **Watermark-reclaimed archive pool**: hundreds of thousands of frames without slowdown
- **Layouts**: four preset workspaces plus custom slots (save as / switch / delete)
- **Themes**: nine colour schemes, Begonia by default, full light and dark coverage
- **Language**: bilingual interface reaching into every panel, switching instantly (your protocol and field names stay untouched)
- **Portability**: protocols, canvas and command library all exchange as JSON; built-in auto-update

</details>

### AI assistant

Since v0.3.6 the AI is not a chat box but an in-app engine.

- **Create by conversation**: protocol templates / control cards / command library / frame-factory protocols / themes / global styles / dockable panels / sandbox widgets / borderless widgets / direct actions / privileged scripts — ten output kinds, each installed from a confirmation card
- **Say it, it happens**: requests such as opening a panel, switching layout or connecting a port are executed directly rather than described, through 27 whitelisted actions; destructive ones are flagged red and still need your confirmation
- **Everything is an API**: sandbox components receive `window.uartix` — keyboard / cursor listening, AI reasoning awareness, asking the AI, custom context menus, window control, cross-widget broadcast, speech, theme subscription
- **Borderless mode**: transparent window, drag-to-move while held, snap-and-dock on release, screen-edge clamping — build floating dashboards, notification strips, or a desktop pet (the pet is only an example; the capability is general)
- **Visible and safe**: multi-stage reasoning streamed as it happens, no install button until generation completes, and sandbox components follow global theme changes live

---

## Quick start

1. Pick a serial port and baud rate to connect, or switch to TCP / UDP at the top; with no hardware, start the demo source
2. Drag-select the fixed leading bytes of a frame on the Hex stream, then right-click "Set as header"
3. Keep selecting the length field, payload and checksum; adjust endianness / type / scale in the properties panel; enable "discriminator" on the function-code field to separate frame types
4. Parsed fields register as variables — click a legend eye to plot a curve, bind Euler angles in the 3D panel
5. Open the control canvas and drop widgets in for two-way debugging, or assemble frames in the console's frame factory
6. Or simply tell the AI assistant: "define this protocol for me", "make a borderless floating thermometer"

---

## Download

These links **always point at the latest release** — they never need updating:

| Platform | Permanent link |
|---|---|
| Windows x64 | [Uartix-Plus-windows-x64-Setup.exe][dl-win] |
| Linux AppImage | [Uartix-Plus-linux-x64.AppImage][dl-appimage] |
| Linux deb | [Uartix-Plus-linux-x64.deb][dl-deb] |

Older versions and full changelogs live on [Releases][get-it]; tutorials and docs on the [website][website].

> **Install notes** — On Windows, if SmartScreen objects on first run, choose "More info" then "Run anyway".
> The Linux AppImage needs `libfuse2` (`sudo apt install libfuse2`); install the deb with `sudo dpkg -i`.
> Existing installs: use "Settings → Check for updates" inside the app.

---

## Building from source

```bash
# Requirements: Node.js 18+ · Rust 1.77+ · WebView2 (Win) / WebKitGTK (Linux)
npm install
npm run tauri dev      # development
npm run tauri build    # bundles land in src-tauri/target/release/bundle/
```

Linux build dependencies:

```bash
sudo dnf install libwebkit2gtk-4.1-devel build-essential libxdo-devel \
  openssl-devel libayatana-appindicator3-devel librsvg2-devel
```

Before committing, make sure `cargo test` (20 Rust cases) and `npx tsc --noEmit` both pass.

<details>
<summary><b>Project layout</b></summary>

```
src/
  features/
    ai/             AI assistant: chat and streaming, ten block installers, uartix bridge, widget host
    protocol/       template engine, drag-select definition, properties panel
    framecanvas/    Hex frame canvas (Canvas rendering + virtualisation + archive pool)
    controls/       control canvas, widgets, command library, scripts
    console/        console, quick command bar, frame factory
    settings/       settings centre, layout slots, import and export
    serial/         serial and network session state
    table/ plot/ view3d/ hexview/ video/ help/
  i18n/             bilingual strings (central keys + inline pairs)
  panels/           dockview panel registry
  shell/            custom title bar, application shell
  shared/           icons, shared components, byte parsing helpers
src-tauri/          Rust: serial, TCP / UDP, parallel parsing, checksums, AI streaming, file IO
```

</details>

---

<div align="center">

**Issues and pull requests are welcome.** Please make sure `cargo test` and `npx tsc --noEmit` pass before submitting.

[![GitHub issues][badge-is]][issues] · [Website][website] · [中文 README](README.md)

Built with Rust + Tauri 2 + React · **MIT** [License][license]

</div>

<!-- ── Links and badges ───────────────────────────────────── -->

[website]: https://larix.teuioe.cn/uartix-plus
[get-it]: https://github.com/Tanixs/uartix-plus/releases/latest
[issues]: https://github.com/Tanixs/uartix-plus/issues
[license]: LICENSE

[dl-win]: https://github.com/Tanixs/uartix-plus/releases/latest/download/Uartix-Plus-windows-x64-Setup.exe
[dl-appimage]: https://github.com/Tanixs/uartix-plus/releases/latest/download/Uartix-Plus-linux-x64.AppImage
[dl-deb]: https://github.com/Tanixs/uartix-plus/releases/latest/download/Uartix-Plus-linux-x64.deb

[badge-rel]: https://img.shields.io/github/v/release/Tanixs/uartix-plus?label=version&color=2ea44f&logo=github
[badge-dl]: https://img.shields.io/github/downloads/Tanixs/uartix-plus/total?label=downloads&color=007ec6&logo=github
[badge-li]: https://img.shields.io/badge/license-MIT-blue.svg
[badge-pf]: https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey
[badge-ta]: https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?logo=tauri
[badge-is]: https://img.shields.io/github/issues/Tanixs/uartix-plus?color=yellow
[tauri]: https://v2.tauri.app/
