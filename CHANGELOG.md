# Changelog

## [0.1.0] - 2026-11-27

First release on npm and in the Pi package gallery.

- Chat view toggled with `alt+c` or `/chat`: your messages in a box, replies whole, thinking folded with a
  preview, runs of tool steps folded into one line with their duration, cards with command, diff and output.
- Live updates while the agent works; scrolling up is never interrupted by new output.
- Text selection and copy limited to the chat; images drawn on Kitty-protocol terminals.
- Gentle Shell aware: keeps its header, Status rail and input box clear, and draws its tools and notices
  with Gentle's own glyphs.
- Click an image drawn in the chat to see it enlarged in a modal; `Esc`, `alt+c`, `q` or a click closes it
  (Kitty-protocol terminals).
- Works with Pi 1.6 (read-only render output) and Gentle Shell 4.8.
