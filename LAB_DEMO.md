# GeekedNet 3D lab demo

The normal app now opens a real 3D workbench. The network simulation, configuration,
missions, and progress still use the existing engine and store.

Run `npm run dev` and open <http://localhost:5173/?view=3d>.

- **Quick setup** gives the two First Contact PCs compatible addresses. Press
  **Run ping** to watch a packet traverse the physical cables and switch.
- Click equipment, its nameplate, or the device selector above the bench to zoom
  into it and configure it in the right panel. Selecting another device pulls
  back before moving into its close-up. **Reset view** returns to the whole bench.
- Clicking empty bench or background space also returns to the whole lab;
  dragging still rotates the view. Compact nameplates use green IP details and
  blue port details, leaving the equipment visible.
- Drag empty lab space to rotate the view. Scroll or pinch to zoom, or use the
  **+ / −** buttons. Right-drag to pan. Moving the pointer alone leaves the view
  steady. The side controls provide overhead view and work lights.
- Drag equipment to move it. Click a device to configure it and click empty
  space or **Reset view** to return to the complete lab.
- Drag a PC, switch, or router from the inventory onto the work surface.
- Click a cable to unplug it. Use **Connect cables** and select two devices to
  connect their next available ports.
- Remove the selected device with **Remove device** or Delete. **Undo** restores
  the device and its original cables.
- **2D Map** switches to the original diagram without changing the network.
- A browser without WebGL can open **2D Map** from the fallback screen.
- Blue and green packets show network activity; link lights and the completion bar are green.
  Blue trim and restrained bloom highlight the equipment and cables.
  Cables use a thin bright-blue line with a wider invisible click target; packets
  appear as six larger alternating blue/green dots with fading tails. A fast burst
  accompanies each ping, then successful routes keep streaming. Dots stay readable
  as the camera zooms, and stop on disconnected or powered-off links.
  The 3D layout adds spacing
  without changing the authored topology or the network engine.
- The background racks combine steady power lights with asynchronous activity
  lights. The wall monitor carries a slow simulated shell/security feed, clearly
  separated from the student's real lab state. **Quiet background** freezes and
  dims this atmosphere; reduced-motion settings also disable those animations.

Hardware, room, lighting, and cables are rendered locally using Three.js; there
are no external model or texture downloads. Progress remains in browser storage.
The private hosted copy has independent progress from the local development app.
