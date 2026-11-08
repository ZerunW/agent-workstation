# Get started

Agent Workstation is a private AI workstation that runs on a Linux server. You use it from a web browser or the
Agent Workstation app for macOS: chat with Claude, or give it a folder to work in. The server is never on the public
internet. You reach it through **Tailscale**, a private network that only your devices can join.

You need a Tailscale account, the server in your tailnet, and the server's address.

## 1. Install Tailscale and sign in

1. Install Tailscale from [tailscale.com/download](https://tailscale.com/download) (macOS, Windows, Linux, iPhone,
   iPad, Android).
2. Open it and sign in. A free personal account is enough; signing in with Google, Microsoft, GitHub or Apple works.
3. Leave Tailscale switched on while you use Agent Workstation.

## 2. Add the server to this device's tailnet

- **Same Tailscale account as the server:** nothing to do. The server is already in your device list (usually named
  `workstation`).
- **Another Tailscale account** (a work account, for example): share the server with that account from the Tailscale
  admin console (the server's `…` menu → **Share…**), then open the invitation on the device and accept it. The
  server then appears in that device's list.

## 3. Open Agent Workstation

- **In a browser:** open the server's address while Tailscale is on.
- **On a Mac:** download the app from `/download` (separate builds for Apple Silicon and Intel; the page recommends
  the right one). Open the disk image, drag Agent Workstation to Applications, start it and
  enter the server's address once.

<details>
<summary>"Apple could not verify Agent Workstation" on first launch</summary>

The app is signed, but not notarized by Apple. Open **System Settings → Privacy & Security**, scroll down and click
**Open Anyway** for Agent Workstation. macOS asks only once per Mac.
</details>

## 4. Pick your name

Agent Workstation has no passwords. The first time a device connects, choose a name (a–z, 0–9, `-`, `_`). Agent Workstation remembers that
name for your Tailscale account, so every device signed in to that account opens straight into your workspace.

## 5. First steps

- **Chat:** the speech-bubble mode. Ask anything; attach images, PDFs and files. Pick the model (and how hard it
  thinks, "effort") in the pill under the message box.
- **Code:** the `</>` mode. Start a session in your workspace, or in a folder you synced from your Mac, and let the
  agent read, edit and run code there. It asks before risky steps; you answer on the card. In the Mac app, linking a
  folder first shows a window where you uncheck what should stay on your Mac.
- **Gear menu (bottom left):** theme, notifications, session defaults, your instructions for the AI, memory, skills,
  and these docs.
- **Ask about Agent Workstation:** the round button on this page answers questions from these two pages with Claude Sonnet. You need to be signed in to use it.

## Troubleshooting

<details>
<summary>The page does not load</summary>

- Is Tailscale on, and is the server in this device's device list? The server only answers devices in the tailnet.
- The Mac app shows **Can't reach your hub** with buttons to open Tailscale or try again.
</details>

<details>
<summary>"Name is taken"</summary>

Each name belongs to one Tailscale account. Choose another name, or sign in to Tailscale with the account that
created it.
</details>

<details>
<summary>A device is refused even though Tailscale is on</summary>

Devices added with a tag (servers, shared machines) have no personal identity, so Agent Workstation refuses them. Sign in to
Tailscale on that device with your own account.
</details>

<details>
<summary>Sending is disabled</summary>

A line above the message box says why: remote use is paused on the admin page, the weekly limit is reached, the
server's disk is almost full (read-only until space is freed), no Anthropic API key is set up on the server, or this
month's API budget is used up. The budget resets on its own.
</details>
