/**
 * ESP Room Architect & Map
 *
 * Draw the home's floor plan, place ESP nodes and appliances in it, and see the
 * layout in 2D or 2.5D isometric. Ported from VoltOrchestra, where it was
 * RoomSimulator, and adapted to Aether's props.
 *
 * It replaces the old Digital Twin view. That one rendered a fixed three.js
 * model - pretty, but it showed a house nobody could edit. This one lets you
 * lay out YOUR home, which is what makes per-room occupancy and the door graph
 * mean anything.
 *
 * The layout is component state and is not persisted yet. Reloading the page
 * returns the default rooms. Wiring it to the backend's layout app (which
 * already has Room and doors models) is the obvious next step.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Home,
  Cpu,
  Plus,
  Trash2,
  Move,
  Maximize2,
  DoorClosed,
  Square,
  Sparkles,
  Wifi,
  Activity,
  Zap,
  Sliders,
  Maximize,
  Eye,
  CheckCircle,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const getRoomWallElements = (room, allRooms, wallDir) => {
  const native = room.elements
    .filter(e => e.wall === wallDir)
    .map(e => ({ ...e, isProjected: false }));

  const projected = [];

  allRooms.forEach(other => {
    if (other.id === room.id) return;

    if (wallDir === 'North') {
      if (other.y + other.height === room.y) {
        const overlapStart = Math.max(room.x, other.x);
        const overlapEnd = Math.min(room.x + room.width, other.x + other.width);
        if (overlapEnd > overlapStart) {
          other.elements.forEach(elem => {
            if (elem.wall === 'South') {
              const elemX = other.x + (other.width * (elem.offset / 100));
              if (elemX >= room.x && elemX <= room.x + room.width) {
                const projectedOffset = ((elemX - room.x) / room.width) * 100;
                projected.push({
                  ...elem,
                  id: `projected-${elem.id}`,
                  wall: 'North',
                  offset: projectedOffset,
                  isProjected: true
                });
              }
            }
          });
        }
      }
    } else if (wallDir === 'South') {
      if (other.y === room.y + room.height) {
        const overlapStart = Math.max(room.x, other.x);
        const overlapEnd = Math.min(room.x + room.width, other.x + other.width);
        if (overlapEnd > overlapStart) {
          other.elements.forEach(elem => {
            if (elem.wall === 'North') {
              const elemX = other.x + (other.width * (elem.offset / 100));
              if (elemX >= room.x && elemX <= room.x + room.width) {
                const projectedOffset = ((elemX - room.x) / room.width) * 100;
                projected.push({
                  ...elem,
                  id: `projected-${elem.id}`,
                  wall: 'South',
                  offset: projectedOffset,
                  isProjected: true
                });
              }
            }
          });
        }
      }
    } else if (wallDir === 'West') {
      if (other.x + other.width === room.x) {
        const overlapStart = Math.max(room.y, other.y);
        const overlapEnd = Math.min(room.y + room.height, other.y + other.height);
        if (overlapEnd > overlapStart) {
          other.elements.forEach(elem => {
            if (elem.wall === 'East') {
              const elemY = other.y + (other.height * (elem.offset / 100));
              if (elemY >= room.y && elemY <= room.y + room.height) {
                const projectedOffset = ((elemY - room.y) / room.height) * 100;
                projected.push({
                  ...elem,
                  id: `projected-${elem.id}`,
                  wall: 'West',
                  offset: projectedOffset,
                  isProjected: true
                });
              }
            }
          });
        }
      }
    } else if (wallDir === 'East') {
      if (other.x === room.x + room.width) {
        const overlapStart = Math.max(room.y, other.y);
        const overlapEnd = Math.min(room.y + room.height, other.y + other.height);
        if (overlapEnd > overlapStart) {
          other.elements.forEach(elem => {
            if (elem.wall === 'West') {
              const elemY = other.y + (other.height * (elem.offset / 100));
              if (elemY >= room.y && elemY <= room.y + room.height) {
                const projectedOffset = ((elemY - room.y) / room.height) * 100;
                projected.push({
                  ...elem,
                  id: `projected-${elem.id}`,
                  wall: 'East',
                  offset: projectedOffset,
                  isProjected: true
                });
              }
            }
          });
        }
      }
    }
  });

  const uniqueProjected = projected.filter(proj => {
    return !native.some(nat => Math.abs(nat.offset - proj.offset) < 5);
  });

  return [...native, ...uniqueProjected];
};

const getWallSegments = (roomLengthPx, wallElems) => {
  const elemWidthPx = 24; // Physical width of doors/windows in pixels
  const elemWidthPct = (elemWidthPx / roomLengthPx) * 100;

  const segments = [];
  let currentPct = 0;

  // Sort elements by offset to process them sequentially
  const sortedElems = [...wallElems].sort((a, b) => a.offset - b.offset);

  sortedElems.forEach(elem => {
    const halfPct = elemWidthPct / 2;
    const leftPct = Math.max(0, elem.offset - halfPct);
    const rightPct = Math.min(100, elem.offset + halfPct);

    if (leftPct > currentPct) {
      segments.push({
        startPct: currentPct,
        endPct: leftPct,
        type: 'solid'
      });
    }

    segments.push({
      startPct: leftPct,
      endPct: rightPct,
      type: elem.type === 'Door' ? 'door' : 'window',
      id: elem.id
    });

    currentPct = rightPct;
  });

  if (currentPct < 100) {
    segments.push({
      startPct: currentPct,
      endPct: 100,
      type: 'solid'
    });
  }

  return segments;
};

export default function RoomArchitectView({
  zones = [],
  onToggleZone,
  addToast,
}) {
  // VoltOrchestra gave this component two callbacks that Aether does not have:
  // appendLog for an activity feed, and addAlert for a four-level notice. Both
  // are reimplemented here in terms of Aether's single addToast, so the 2,500
  // lines below stay exactly as they were rather than being rewritten at
  // twenty-odd call sites.
  const appendLog = React.useCallback((message) => {
    // The activity feed does not exist in Aether. Keep it in the console so the
    // information is not silently dropped while the layout is being worked on.
    console.info('[room architect]', message);
  }, []);

  const addAlert = React.useCallback((title, detail, level = 'info') => {
    const icon = level === 'warning' ? AlertCircle
               : level === 'success' ? CheckCircle
               : Sparkles;
    addToast?.(detail ? `${title} - ${detail}` : title, icon);
  }, [addToast]);

  // 1. Perspective state (2D Flat vs 2.5D Isometric)
  const [viewMode, setViewMode] = useState('3d');

  // Orbiting & zoom states for 2.5D perspective viewport
  const [orbitPitch, setOrbitPitch] = useState(58); // default rotateX
  const [orbitYaw, setOrbitYaw] = useState(-38);   // default rotateZ
  const [orbitZoom, setOrbitZoom] = useState(0.95);  // default scale
  const [isOrbiting, setIsOrbiting] = useState(false);
  const [orbitStart, setOrbitStart] = useState({ x: 0, y: 0, pitch: 58, yaw: -38 });
  const [labelStyle, setLabelStyle] = useState('compact');

  // 2. Active selection index
  const [selectedRoomId, setSelectedRoomId] = useState('room-1');

  // Snapping on/off for precise layouts
  const [snapToGrid, setSnapToGrid] = useState(true);

  // Wall building state for Door & Window installation
  const [selectedWall, setSelectedWall] = useState('North');

  // 3. Pre-populated smart devices (ESPs) in different rooms
  const [esps, setEsps] = useState([
    {
      id: 'esp-central',
      name: 'Central Gateway ESP32-S3',
      ip: '192.168.1.100',
      rssi: -30,
      status: 'Online',
      appliances: [
        { id: 'app-router', name: 'Home Router & Security', type: 'Critical', power: 150, status: 'Active', emoji: '🌐' }
      ]
    },
    {
      id: 'esp-living',
      name: 'Living Room Node ESP32',
      ip: '192.168.1.101',
      rssi: -58,
      status: 'Online',
      appliances: [
        { id: 'app-climate', name: 'Climate Control (A/C)', type: 'Heavy', power: 1200, status: 'Active', emoji: '❄️' },
        { id: 'app-tv', name: 'Smart TV Console', type: 'Light', power: 220, status: 'Active', emoji: '📺' }
      ]
    },
    {
      id: 'esp-kitchen',
      name: 'Kitchen Node ESP32',
      ip: '192.168.1.102',
      rssi: -65,
      status: 'Online',
      appliances: [
        { id: 'app-oven', name: 'Oven & Range Cooker', type: 'Heavy', power: 600, status: 'Active', emoji: '🍳' },
        { id: 'app-fridge', name: 'Smart Refrigerator', type: 'Constant', power: 180, status: 'Active', emoji: '🍺' }
      ]
    },
    {
      id: 'esp-garage',
      name: 'Garage EV Node ESP32-C3',
      ip: '192.168.1.103',
      rssi: -72,
      status: 'Online',
      appliances: [
        { id: 'app-charger', name: 'Electric Car Charger', type: 'Heavy', power: 1800, status: 'Active', emoji: '🚗' },
        { id: 'app-door', name: 'Garage Door Opener', type: 'Momentary', power: 50, status: 'Off', emoji: '🚪' }
      ]
    }
  ]);

  // 4. Pre-populated rooms mapped to grid coordinates (0 to 7 coordinates)
  const [rooms, setRooms] = useState([
    {
      id: 'room-1',
      name: 'Living Room & Dining',
      color: 'blue',
      x: 1,
      y: 1,
      width: 4,
      height: 3,
      espId: 'esp-living',
      elements: [
        { id: 'w1', type: 'Window', wall: 'North', offset: 30 },
        { id: 'w2', type: 'Window', wall: 'North', offset: 70 },
        { id: 'd1', type: 'Door', wall: 'West', offset: 50 }
      ]
    },
    {
      id: 'room-2',
      name: 'Kitchen Hub',
      color: 'orange',
      x: 5,
      y: 1,
      width: 3,
      height: 3,
      espId: 'esp-kitchen',
      elements: [
        { id: 'w3', type: 'Window', wall: 'North', offset: 50 },
        { id: 'd2', type: 'Door', wall: 'West', offset: 20 }
      ]
    },
    {
      id: 'room-3',
      name: 'Attached Garage',
      color: 'purple',
      x: 1,
      y: 4,
      width: 3,
      height: 3,
      espId: 'esp-garage',
      elements: [
        { id: 'd3', type: 'Door', wall: 'South', offset: 50 },
        { id: 'd4', type: 'Door', wall: 'East', offset: 30 }
      ]
    },
    {
      id: 'room-4',
      name: 'Central Server Closet',
      color: 'green',
      x: 4,
      y: 4,
      width: 2,
      height: 2,
      espId: 'esp-central',
      elements: [
        { id: 'd5', type: 'Door', wall: 'South', offset: 50 }
      ]
    }
  ]);

  // Selected room data helper
  const selectedRoom = rooms.find(r => r.id === selectedRoomId);

  // Input fields for width and height in meters (as strings to allow smooth typing)
  const [widthInput, setWidthInput] = useState('');
  const [heightInput, setHeightInput] = useState('');
  const [prevSelectedRoomId, setPrevSelectedRoomId] = useState(null);
  const [prevRoomW, setPrevRoomW] = useState(0);
  const [prevRoomH, setPrevRoomH] = useState(0);

  // Sync inputs with selected room dimensions when they change
  React.useEffect(() => {
    if (selectedRoom) {
      if (selectedRoom.id !== prevSelectedRoomId || selectedRoom.width !== prevRoomW || selectedRoom.height !== prevRoomH) {
        setPrevSelectedRoomId(selectedRoom.id);
        setPrevRoomW(selectedRoom.width);
        setPrevRoomH(selectedRoom.height);
        setWidthInput((selectedRoom.width * 1.5).toFixed(1));
        setHeightInput((selectedRoom.height * 1.5).toFixed(1));
      }
    } else {
      setPrevSelectedRoomId(null);
      setPrevRoomW(0);
      setPrevRoomH(0);
      setWidthInput('');
      setHeightInput('');
    }
  }, [selectedRoom, prevSelectedRoomId, prevRoomW, prevRoomH]);

  const handleWidthInputChange = (valStr) => {
    setWidthInput(valStr);
    const parsed = parseFloat(valStr);
    if (!isNaN(parsed) && parsed > 0) {
      const units = parsed / 1.5;
      if (selectedRoom) {
        const nextW = Math.max(1, Math.min(8 - selectedRoom.x, units));
        const hasOverlap = rooms.some(other => {
          if (other.id === selectedRoom.id) return false;
          return (selectedRoom.x < other.x + other.width && selectedRoom.x + nextW > other.x && selectedRoom.y < other.y + other.height && selectedRoom.y + selectedRoom.height > other.y);
        });
        if (!hasOverlap) {
          setRooms(prev => prev.map(item => item.id === selectedRoom.id ? { ...item, width: nextW } : item));
          setPrevRoomW(nextW);
        }
      }
    }
  };

  const handleHeightInputChange = (valStr) => {
    setHeightInput(valStr);
    const parsed = parseFloat(valStr);
    if (!isNaN(parsed) && parsed > 0) {
      const units = parsed / 1.5;
      if (selectedRoom) {
        const nextH = Math.max(1, Math.min(8 - selectedRoom.y, units));
        const hasOverlap = rooms.some(other => {
          if (other.id === selectedRoom.id) return false;
          return (selectedRoom.x < other.x + other.width && selectedRoom.x + selectedRoom.width > other.x && selectedRoom.y < other.y + other.height && selectedRoom.y + nextH > other.y);
        });
        if (!hasOverlap) {
          setRooms(prev => prev.map(item => item.id === selectedRoom.id ? { ...item, height: nextH } : item));
          setPrevRoomH(nextH);
        }
      }
    }
  };

  const handleInputBlur = (axis) => {
    if (!selectedRoom) return;
    if (axis === 'width') {
      setWidthInput((selectedRoom.width * 1.5).toFixed(1));
    } else {
      setHeightInput((selectedRoom.height * 1.5).toFixed(1));
    }
  };

  const handleInputKeyDown = (e, axis) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  // Drag-and-drop state for room moving
  const [dragState, setDragState] = useState(null);

  // Resize-on-canvas state
  const [resizeState, setResizeState] = useState(null);

  // Refs for reading 3D→2D projected screen positions of room anchor dots
  const canvasCardRef = useRef(null);
  const anchorRefs = useRef({});
  const labelRefs = useRef({});
  const lineRefs = useRef({});
  const circleRefs = useRef({});

  // RAF loop: continuously read the3D anchor dots' screen positions and update the flat2D label overlay
  useEffect(() => {
    if (viewMode !== '3d' || labelStyle === 'hidden') return;
    let raf;
    const tick = () => {
      const card = canvasCardRef.current;
      if (!card) { raf = requestAnimationFrame(tick); return; }
      const cardRect = card.getBoundingClientRect();
      rooms.forEach(r => {
        const anchor = anchorRefs.current[r.id];
        const label = labelRefs.current[r.id];
        const line = lineRefs.current[r.id];
        const circle = circleRefs.current[r.id];
        if (!anchor || !label) { return; }
        const aRect = anchor.getBoundingClientRect();
        const cx = aRect.left + aRect.width / 2 - cardRect.left;
        const cy = aRect.top + aRect.height / 2 - cardRect.top;
        const labelOffset = labelStyle === 'compact' ? 90 : 130;
        label.style.left = `${cx}px`;
        label.style.top = `${cy - labelOffset}px`;
        if (line) {
          line.setAttribute('x1', String(cx));
          line.setAttribute('y1', String(cy));
          line.setAttribute('x2', String(cx));
          line.setAttribute('y2', String(cy - labelOffset + 4));
        }
        if (circle) {
          circle.setAttribute('cx', String(cx));
          circle.setAttribute('cy', String(cy - labelOffset + 4));
        }
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rooms, viewMode, labelStyle]);

  // Helper colors
  const getColorClasses = (colorName) => {
    switch (colorName) {
      case 'blue': return { bg: 'bg-[#F2F6FC]/90', border: 'border-[#0A84FF]', text: 'text-[#0A84FF]', fill: 'bg-[#0A84FF]/10', hex: '#0A84FF' };
      case 'orange': return { bg: 'bg-[#FFF9F5]/90', border: 'border-[#FF9500]', text: 'text-[#FF9500]', fill: 'bg-[#FF9500]/10', hex: '#FF9500' };
      case 'purple': return { bg: 'bg-[#FAF5FF]/90', border: 'border-[#BF5AF2]', text: 'text-[#BF5AF2]', fill: 'bg-[#BF5AF2]/10', hex: '#BF5AF2' };
      case 'green': return { bg: 'bg-[#F3FAF5]/90', border: 'border-[#30D158]', text: 'text-[#30D158]', fill: 'bg-[#30D158]/10', hex: '#30D158' };
      case 'red': return { bg: 'bg-[#FFF5F5]/90', border: 'border-[#FF453A]', text: 'text-[#FF453A]', fill: 'bg-[#FF453A]/10', hex: '#FF453A' };
      case 'pink': return { bg: 'bg-[#FFF0F3]/90', border: 'border-[#FF2D55]', text: 'text-[#FF2D55]', fill: 'bg-[#FF2D55]/10', hex: '#FF2D55' };
      case 'teal': return { bg: 'bg-[#F0FDF4]/90', border: 'border-[#0D9488]', text: 'text-[#0D9488]', fill: 'bg-[#0D9488]/10', hex: '#0D9488' };
      case 'yellow': return { bg: 'bg-[#FEFCE8]/90', border: 'border-[#EAB308]', text: 'text-[#EAB308]', fill: 'bg-[#EAB308]/10', hex: '#EAB308' };
      case 'indigo': return { bg: 'bg-[#EEF2FF]/90', border: 'border-[#5856D6]', text: 'text-[#5856D6]', fill: 'bg-[#5856D6]/10', hex: '#5856D6' };
      case 'cyan': return { bg: 'bg-[#ECFEFF]/90', border: 'border-[#06B6D4]', text: 'text-[#06B6D4]', fill: 'bg-[#06B6D4]/10', hex: '#06B6D4' };
      default: return { bg: 'bg-white', border: 'border-[#8E8E93]', text: 'text-ink/60', fill: 'bg-bg-card/40', hex: '#8E8E93' };
    }
  };

  // Resize Room handlers
  const handleResizeRoom = (axis, change) => {
    if (!selectedRoomId) return;
    const step = snapToGrid ? change : (change * 0.25);
    setRooms(prev => {
      const targetRoom = prev.find(item => item.id === selectedRoomId);
      if (!targetRoom) return prev;

      if (axis === 'width') {
        const nextW = Math.max(1, Math.min(8 - targetRoom.x, targetRoom.width + step));
        const hasOverlap = prev.some(other => {
          if (other.id === targetRoom.id) return false;
          return (targetRoom.x < other.x + other.width && targetRoom.x + nextW > other.x && targetRoom.y < other.y + other.height && targetRoom.y + targetRoom.height > other.y);
        });
        if (hasOverlap) {
          addAlert('Overlap Blocked', `Resizing "${targetRoom.name}" would overlap with another room.`, 'warning');
          return prev;
        }
        const formattedWidth = snapToGrid ? nextW : nextW.toFixed(2);
        appendLog(`MAP SIMULATOR: Resized width of "${targetRoom.name}" to ${formattedWidth} units (${(nextW * 1.5).toFixed(2)}m)`);
        return prev.map(item => item.id === selectedRoomId ? { ...item, width: nextW } : item);
      } else {
        const nextH = Math.max(1, Math.min(8 - targetRoom.y, targetRoom.height + step));
        const hasOverlap = prev.some(other => {
          if (other.id === targetRoom.id) return false;
          return (targetRoom.x < other.x + other.width && targetRoom.x + targetRoom.width > other.x && targetRoom.y < other.y + other.height && targetRoom.y + nextH > other.y);
        });
        if (hasOverlap) {
          addAlert('Overlap Blocked', `Resizing "${targetRoom.name}" would overlap with another room.`, 'warning');
          return prev;
        }
        const formattedHeight = snapToGrid ? nextH : nextH.toFixed(2);
        appendLog(`MAP SIMULATOR: Resized height of "${targetRoom.name}" to ${formattedHeight} units (${(nextH * 1.5).toFixed(2)}m)`);
        return prev.map(item => item.id === selectedRoomId ? { ...item, height: nextH } : item);
      }
    });
  };

  // Add Wall Element (Window or Door)
  const handleAddWallElement = (type, wall) => {
    if (!selectedRoomId) return;
    const newElement = {
      id: `elem-${Date.now()}`,
      type,
      wall,
      offset: 50, // default center
    };

    setRooms(prev => prev.map(r => {
      if (r.id !== selectedRoomId) return r;
      appendLog(`MAP SIMULATOR: Installed a custom ${type} on the ${wall} wall of "${r.name}"`);
      addAlert(`${type} Installed`, `Positioned a new ${type.toLowerCase()} in your ${r.name}.`, 'success');
      return {
        ...r,
        elements: [...r.elements, newElement]
      };
    }));
  };

  // Delete Wall Element
  const handleDeleteWallElement = (elementId) => {
    if (!selectedRoomId) return;
    setRooms(prev => prev.map(r => {
      if (r.id !== selectedRoomId) return r;
      const filtered = r.elements.filter(e => e.id !== elementId);
      appendLog(`MAP SIMULATOR: Removed wall element from "${r.name}"`);
      return { ...r, elements: filtered };
    }));
  };

  // Update Wall Element Offset
  const handleUpdateElementOffset = (elementId, value) => {
    if (!selectedRoomId) return;
    setRooms(prev => prev.map(r => {
      if (r.id !== selectedRoomId) return r;
      return {
        ...r,
        elements: r.elements.map(e => e.id === elementId ? { ...e, offset: value } : e)
      };
    }));
  };

  // Add New Custom Room with premium template and auto-positioning
  const handleAddRoomWithTemplate = (
    templateName,
    color,
    width,
    height,
    appliances,
    defaultEspId
  ) => {
    const nextId = `room-${Date.now()}`;

    // Create a new ESP node specifically for this template to avoid collisions
    const nextEspId = `esp-${Date.now()}`;
    const newEsp = {
      id: nextEspId,
      name: `${templateName.replace(/[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD00-\uDFFF]/g, '').trim()} Node ESP32`,
      ip: `192.168.1.${104 + rooms.length}`,
      rssi: -50 - Math.floor(Math.random() * 25),
      status: 'Online',
      appliances: appliances,
    };

    // Add the new ESP node to the ESP list
    setEsps(prev => [...prev, newEsp]);

    // Find a free spot on the 8x8 grid for this room size (simple scan)
    let foundX = 0;
    let foundY = 0;
    let spotFound = false;

    for (let y = 0; y <= 8 - height; y++) {
      for (let x = 0; x <= 8 - width; x++) {
        // Check if this box overlaps any existing room
        const overlap = rooms.some(r => {
          return (x < r.x + r.width && x + width > r.x && y < r.y + r.height && y + height > r.y);
        });
        if (!overlap) {
          foundX = x;
          foundY = y;
          spotFound = true;
          break;
        }
      }
      if (spotFound) break;
    }

    // Fallback if full
    if (!spotFound) {
      addAlert('Grid is Full', 'No available space found for this room. Please move, resize, or delete existing rooms first!', 'warning');
      appendLog('MAP SIMULATOR: Failed to place new room - no free space on the grid.');
      return;
    }

    // Resolve unique color
    const allColors = ['blue', 'orange', 'purple', 'green', 'red', 'pink', 'teal', 'yellow', 'indigo', 'cyan'];
    const usedColors = rooms.map(r => r.color);
    let finalColor = color;
    if (usedColors.includes(color) || !color) {
      const unusedColor = allColors.find(c => !usedColors.includes(c));
      if (unusedColor) {
        finalColor = unusedColor;
      } else {
        finalColor = allColors[rooms.length % allColors.length];
      }
    }

    const newRoom = {
      id: nextId,
      name: templateName,
      color: finalColor,
      x: foundX,
      y: foundY,
      width: width,
      height: height,
      espId: nextEspId,
      elements: [
        { id: `elem-init-w-${Date.now()}`, type: 'Window', wall: 'North', offset: 50 },
        { id: `elem-init-d-${Date.now()}`, type: 'Door', wall: 'South', offset: 50 }
      ]
    };

    setRooms(prev => [...prev, newRoom]);
    setSelectedRoomId(nextId);
    appendLog(`MAP SIMULATOR: Created a premium "${templateName}" layout on Grid (${foundX}, ${foundY}) with auto-configured ESP32 telemetry!`);
    addAlert('Room Built', `${templateName} successfully configured with smart sensors.`, 'success');
  };

  const handleAddRoom = () => {
    const allColors = ['blue', 'orange', 'purple', 'green', 'red', 'pink', 'teal', 'yellow', 'indigo', 'cyan'];
    const usedColors = rooms.map(r => r.color);
    const unusedColor = allColors.find(c => !usedColors.includes(c)) || allColors[rooms.length % allColors.length];

    handleAddRoomWithTemplate(
      `Custom Room ${rooms.length + 1}`,
      unusedColor,
      3,
      3,
      [
        { id: `app-custom-${Date.now()}`, name: 'Smart Appliance', type: 'Light', power: 100, status: 'Active', emoji: '🔌' }
      ],
      'esp-central'
    );
  };

  // Delete Room
  const handleDeleteRoom = (roomId) => {
    if (rooms.length <= 1) {
      addAlert('Action Locked', 'You must have at least one room mapped on your smart layout.', 'warning');
      return;
    }
    const target = rooms.find(r => r.id === roomId);
    setRooms(prev => prev.filter(r => r.id !== roomId));
    setSelectedRoomId(rooms.find(r => r.id !== roomId)?.id || null);
    if (target) {
      appendLog(`MAP SIMULATOR: Deleted Room: "${target.name}" and cleared layout nodes.`);
      addAlert('Room Removed', `Deleted "${target.name}" layout.`, 'info');
    }
  };

  // Toggle ESP Appliance Switch directly
  const handleToggleAppliance = (espId, appId) => {
    setEsps(prev => prev.map(e => {
      if (e.id !== espId) return e;
      return {
        ...e,
        appliances: e.appliances.map(app => {
          if (app.id !== appId) return app;
          const nextStatus = app.status === 'Active' ? 'Off' : 'Active';
          appendLog(`ESP NODE: ${e.name} commanded appliance "${app.name}" to ${nextStatus.toUpperCase()}`);

          // Propagate toggle to central app system drawer if possible
          // Only appliances that correspond to a real paired zone actually
          // switch anything. The rest are part of the layout sketch, and
          // saying so is better than pretending a relay moved.
          const target = zones.find(
            z => z.name?.toLowerCase() === app.name?.toLowerCase()
              || z.id === appId
          );
          if (target && onToggleZone) {
            onToggleZone(target.id);
          } else {
            appendLog(`No paired zone matches "${app.name}" - simulated only`);
          }

          return { ...app, status: nextStatus };
        })
      };
    }));
  };

  // Camera orbit & mouse control handlers
  const handleOrbitPointerDown = (e) => {
    if (viewMode !== '3d') return;

    // Check if the user clicked inside buttons, inputs, selects (handled by their respective elements)
    const target = e.target;
    if (target.closest('button') || target.closest('input') || target.closest('select')) {
      return;
    }

    setIsOrbiting(true);
    setOrbitStart({
      x: e.clientX,
      y: e.clientY,
      pitch: orbitPitch,
      yaw: orbitYaw
    });

    if (typeof target.setPointerCapture === 'function') {
      target.setPointerCapture(e.pointerId);
    }
  };

  const handleOrbitPointerMove = (e) => {
    if (!isOrbiting || viewMode !== '3d') return;

    const deltaX = e.clientX - orbitStart.x;
    const deltaY = e.clientY - orbitStart.y;

    // Horizontally dragging mouse changes rotation yaw (around Z-axis)
    // Vertically dragging mouse changes tilt pitch (around X-axis)
    // Inverted delta signs to align with intuitive orbital camera controls
    const sensitivity = 0.55;
    const nextYaw = orbitStart.yaw - deltaX * sensitivity;
    let nextPitch = orbitStart.pitch - deltaY * sensitivity;

    // Clamp pitch to avoid extreme visual warping or flipping upside down (10deg to 85deg)
    nextPitch = Math.max(10, Math.min(85, nextPitch));

    setOrbitPitch(nextPitch);
    setOrbitYaw(nextYaw);
  };

  const handleOrbitPointerUp = (e) => {
    if (isOrbiting) {
      setIsOrbiting(false);
      const target = e.target;
      if (typeof target.releasePointerCapture === 'function') {
        target.releasePointerCapture(e.pointerId);
      }
    }
  };

  const handleOrbitWheel = (e) => {
    if (viewMode !== '3d') return;

    // Stop body scrolling when scrolling over active canvas
    e.preventDefault();

    const zoomStep = 0.05;
    const nextZoom = e.deltaY < 0
      ? Math.min(1.8, orbitZoom + zoomStep)
      : Math.max(0.4, orbitZoom - zoomStep);
    setOrbitZoom(nextZoom);
  };

  // Calculate live power for a room
  const getRoomPowerDraw = (roomId) => {
    const rm = rooms.find(r => r.id === roomId);
    if (!rm) return 0;
    const esp = esps.find(e => e.id === rm.espId);
    if (!esp) return 0;
    return esp.appliances
      .filter(app => app.status === 'Active')
      .reduce((sum, app) => sum + app.power, 0);
  };

  return (
    <div className="bg-panel-purple-bg border-panel-purple-border rounded-[24px] border p-4 sm:p-8 shadow-sm h-full flex flex-col justify-between transition-all duration-300">
      <div>
        {/* Simplified, user-friendly Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-[#FDFBF7] pb-6 mb-6">
          <div>
            <div className="text-[#BF5AF2] font-mono text-[11px] font-semibold uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#30D158] animate-pulse"></span>
              <span>2.5D Room ESP Mapping Simulator</span>
            </div>
            <h2 className="text-2xl font-semibold text-[#3E423A] tracking-tight">Interactive Smart House Builder</h2>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Grid Snapping Toggle */}
            <div className="flex items-center bg-[#FDFBF7] p-1 rounded-xl border border-[#E4E0D2] text-xs gap-2">
              <span className="text-[10px] text-ink/50 font-bold uppercase tracking-wider pl-2.5">Snapping:</span>
              <div className="flex items-center bg-bg-card/70/50 rounded-lg p-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setSnapToGrid(true);
                    // Automatically snap all rooms to whole grid values when turned back on
                    setRooms(prev => prev.map(r => ({
                      ...r,
                      x: Math.round(r.x),
                      y: Math.round(r.y),
                      width: Math.max(1, Math.round(r.width)),
                      height: Math.max(1, Math.round(r.height)),
                    })));
                    appendLog('MAP SIMULATOR: Grid snapping enabled. All rooms aligned to nearest grid coordinates.');
                    addAlert('Snapping Enabled', 'Room coordinates aligned to layout grid.', 'success');
                  }}
                  className={`px-2 py-0.5 rounded font-extrabold text-[9px] tracking-wide uppercase transition-all ${snapToGrid
                    ? 'bg-olive text-white shadow-sm'
                    : 'text-ink/50 hover:text-ink'
                    }`}
                >
                  On
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSnapToGrid(false);
                    appendLog('MAP SIMULATOR: Grid snapping disabled. Rooms can now be dragged/resized with free precision!');
                    addAlert('Snapping Disabled', 'Rooms can now be sized and moved continuously.', 'warning');
                  }}
                  className={`px-2 py-0.5 rounded font-extrabold text-[9px] tracking-wide uppercase transition-all ${!snapToGrid
                    ? 'bg-[#FF9500] text-white shadow-sm'
                    : 'text-ink/50 hover:text-ink'
                    }`}
                >
                  Off
                </button>
              </div>
            </div>

            {/* View Mode Switcher */}
            <div className="flex items-center bg-[#FDFBF7] p-1 rounded-xl border border-[#E4E0D2] text-xs">
              <button
                onClick={() => setViewMode('2d')}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all ${viewMode === '2d'
                  ? 'bg-white text-[#3E423A] shadow-sm border border-[#E4E0D2]'
                  : 'text-ink/50 hover:text-ink'
                  }`}
              >
                2D Blueprint
              </button>
              <button
                onClick={() => setViewMode('3d')}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all ${viewMode === '3d'
                  ? 'bg-white text-[#3E423A] shadow-sm border border-[#E4E0D2]'
                  : 'text-ink/50 hover:text-ink'
                  }`}
              >
                2.5D Perspective
              </button>
            </div>
          </div>
        </div>

        {/* Main interactive grid section split */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">

          {/* Interactive Map Visualizer Canvas (8 columns) */}
          <div className="xl:col-span-8 flex flex-col gap-4">

            {/* Visual Canvas Card */}
            <div
              ref={canvasCardRef}
              onPointerDown={handleOrbitPointerDown}
              onPointerMove={handleOrbitPointerMove}
              onPointerUp={handleOrbitPointerUp}
              onPointerLeave={handleOrbitPointerUp}
              onWheel={handleOrbitWheel}
              className={`relative bg-[#FAF9F6] rounded-[24px] border border-[#E4E0D2] p-6 min-h-[440px] flex items-center justify-center overflow-hidden shadow-inner ${viewMode === '3d' ? 'cursor-grab active:cursor-grabbing select-none' : ''}`}
            >

              {/* Mesh Network Grid Lines background */}
              <div className="absolute inset-0 opacity-[0.06]"
                style={{
                  backgroundImage: 'radial-gradient(circle, #000000 1.2px, transparent 1.2px)',
                  backgroundSize: '24px 24px'
                }}
              />

              {/* 2.5D Isometric transform container */}
              <div
                id="floorgrid-canvas"
                className="relative flex items-center justify-center"
                style={{
                  width: '100%',
                  maxWidth: '480px',
                  height: '380px',
                  perspective: '1200px',
                  transform: viewMode === '3d'
                    ? `translateY(60px) rotateX(${orbitPitch}deg) rotateZ(${orbitYaw}deg) scale(${orbitZoom})`
                    : 'rotateX(0deg) rotateZ(0deg) scale(1)',
                  transformStyle: 'preserve-3d',
                  transition: isOrbiting ? 'none' : 'transform 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
                }}
              >
                {/* Visual ESP Mesh Connections (Hub-and-Spoke Drawing from central closet room) */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible" style={{ transform: 'translateZ(1px)' }}>
                  {/* Draw connection lines from room nodes to Central Closet (room-4) */}
                  {rooms.map(r => {
                    if (r.id === 'room-4') return null; // self
                    const centerR = {
                      x: (r.x + r.width / 2) * 12.5,
                      y: (r.y + r.height / 2) * 12.5
                    };
                    const centerHub = {
                      x: (4 + 1) * 12.5, // room-4 x is 4, width 2 => center x is 5
                      y: (4 + 1) * 12.5  // room-4 y is 4, height 2 => center y is 5
                    };
                    return (
                      <g key={`mesh-${r.id}`}>
                        {/* Wireless pulse path */}
                        <line
                          x1={`${centerR.x}%`}
                          y1={`${centerR.y}%`}
                          x2={`${centerHub.x}%`}
                          y2={`${centerHub.y}%`}
                          stroke="#BF5AF2"
                          strokeWidth="2"
                          strokeDasharray="4,6"
                          className="opacity-40 animate-pulse"
                        />
                        {/* Dynamic packet dot */}
                        <circle r="4" fill="#30D158">
                          <animateMotion
                            path={`M ${(centerR.x / 100) * 440},${(centerR.y / 100) * 380} L ${(centerHub.x / 100) * 440},${(centerHub.y / 100) * 380}`}
                            dur="2s"
                            repeatCount="indefinite"
                          />
                        </circle>
                      </g>
                    );
                  })}
                </svg>

                {/* Flat/3D Ground Grid Floor */}
                <div
                  className="absolute inset-0 rounded-2xl shadow-lg transition-all duration-500"
                  style={{
                    backgroundColor: viewMode === '3d' ? '#B8B09F' : '#FFFFFF',
                    border: viewMode === '3d' ? '3px solid #9C9585' : '1px solid #E4E0D2',
                    boxShadow: viewMode === '3d' ? '0 30px 60px -15px rgba(0, 0, 0, 0.3), 0 10px 20px -5px rgba(0, 0, 0, 0.15)' : 'none',
                    transform: viewMode === '3d' ? 'translateZ(-2px)' : 'none',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
                    gridTemplateRows: 'repeat(8, minmax(0, 1fr))',
                    overflow: 'hidden'
                  }}
                >
                  {[...Array(64)].map((_, idx) => (
                    <div
                      key={idx}
                      className="transition-colors duration-500"
                      style={{
                        border: viewMode === '3d'
                          ? '0.5px solid rgba(255, 255, 255, 0.08)'
                          : '0.5px solid rgba(0, 0, 0, 0.05)'
                      }}
                    />
                  ))}
                </div>

                {/* Render Rooms */}
                {rooms.map((r) => {
                  const colors = getColorClasses(r.color);
                  const isSelected = selectedRoomId === r.id;

                  // Grid-to-pixel metrics based on % parent container
                  const leftPct = r.x * 12.5;
                  const topPct = r.y * 12.5;
                  const widthPct = r.width * 12.5;
                  const heightPct = r.height * 12.5;

                  const linkedEsp = esps.find(e => e.id === r.espId);
                  const activeAppliances = linkedEsp ? linkedEsp.appliances.filter(app => app.status === 'Active') : [];

                  return (
                    <div
                      key={r.id}
                      onClick={(e) => {
                        if (viewMode === '3d') {
                          setSelectedRoomId(r.id);
                          return;
                        }
                        e.stopPropagation();
                        setSelectedRoomId(r.id);
                      }}
                      onPointerDown={(e) => {
                        // Avoid triggering drag if the user clicks inside interactive components (like buttons/inputs/selects)
                        const target = e.target;
                        if (target.closest('button') || target.closest('input') || target.closest('select')) {
                          return;
                        }

                        // In 3D mode, rooms are static and NOT draggable. We let events bubble up to the background 
                        // so that dragging anywhere on the canvas (including on rooms) rotates/orbits the camera.
                        if (viewMode === '3d') {
                          setSelectedRoomId(r.id);
                          return;
                        }

                        e.stopPropagation();

                        // Set pointer capture to lock mouse moves to this element even if cursor leaves during high-speed drag
                        if (typeof target.setPointerCapture === 'function') {
                          target.setPointerCapture(e.pointerId);
                        }

                        setSelectedRoomId(r.id);
                        setDragState({
                          roomId: r.id,
                          startRoomX: r.x,
                          startRoomY: r.y,
                          startX: e.clientX,
                          startY: e.clientY,
                        });
                      }}
                      onPointerMove={(e) => {
                        if (!dragState || dragState.roomId !== r.id) return;
                        e.stopPropagation();

                        const deltaX = e.clientX - dragState.startX;
                        const deltaY = e.clientY - dragState.startY;

                        const container = document.getElementById('floorgrid-canvas');
                        const rect = container ? container.getBoundingClientRect() : { width: 440, height: 380 };

                        // Responsive grid scale:
                        // In 2D Blueprint, 1 unit is exactly containerWidth / 8.
                        // In 2.5D Perspective, we scale the visual ratios.
                        const scaleFactorX = viewMode === '3d' ? 38 : (rect.width / 8);
                        const scaleFactorY = viewMode === '3d' ? 28 : (rect.height / 8);

                        let deltaGridX = deltaX / scaleFactorX;
                        let deltaGridY = deltaY / scaleFactorY;

                        if (snapToGrid) {
                          deltaGridX = Math.round(deltaGridX);
                          deltaGridY = Math.round(deltaGridY);
                        } else {
                          // Keep high precision but rounded to 2 decimal places for neatness
                          deltaGridX = Math.round(deltaGridX * 100) / 100;
                          deltaGridY = Math.round(deltaGridY * 100) / 100;
                        }

                        const nextX = Math.max(0, Math.min(8 - r.width, dragState.startRoomX + deltaGridX));
                        const nextY = Math.max(0, Math.min(8 - r.height, dragState.startRoomY + deltaGridY));

                        let finalX = r.x;
                        let finalY = r.y;

                        // Slide on X axis
                        const hasXOverlap = rooms.some(other => {
                          if (other.id === r.id) return false;
                          return (nextX < other.x + other.width && nextX + r.width > other.x && r.y < other.y + other.height && r.y + r.height > other.y);
                        });
                        if (!hasXOverlap) {
                          finalX = nextX;
                        }

                        // Slide on Y axis
                        const hasYOverlap = rooms.some(other => {
                          if (other.id === r.id) return false;
                          return (finalX < other.x + other.width && finalX + r.width > other.x && nextY < other.y + other.height && nextY + r.height > other.y);
                        });
                        if (!hasYOverlap) {
                          finalY = nextY;
                        }

                        if (finalX !== r.x || finalY !== r.y) {
                          setRooms(prev => prev.map(item => {
                            if (item.id === r.id) {
                              return { ...item, x: finalX, y: finalY };
                            }
                            return item;
                          }));
                        }
                      }}
                      onPointerUp={(e) => {
                        if (dragState && dragState.roomId === r.id) {
                          e.stopPropagation();
                          const target = e.target;
                          if (typeof target.releasePointerCapture === 'function') {
                            target.releasePointerCapture(e.pointerId);
                          }

                          const formattedCoords = snapToGrid
                            ? `(${r.x}, ${r.y})`
                            : `(${r.x.toFixed(2)}, ${r.y.toFixed(2)})`;

                          appendLog(`MAP SIMULATOR: Dragged and repositioned room "${r.name}" to position ${formattedCoords}`);
                          setDragState(null);
                        }
                      }}
                      className={`absolute rounded-xl select-none touch-none flex flex-col justify-between p-3 border-2 ${colors.bg} ${colors.border} ${isSelected
                        ? 'z-10'
                        : viewMode === '3d'
                          ? 'shadow-sm'
                          : 'opacity-85 hover:opacity-100 shadow-sm'
                        } ${viewMode === '3d' ? 'cursor-inherit' : (dragState?.roomId === r.id ? 'cursor-grabbing opacity-90 scale-[1.01]' : 'cursor-grab')}`}
                      style={{
                        left: `${leftPct}%`,
                        top: `${topPct}%`,
                        width: `${widthPct}%`,
                        height: `${heightPct}%`,
                        backgroundColor: viewMode === '3d' ? '#A47C5C' : undefined,
                        transform: viewMode === '3d'
                          ? 'translateZ(4px)'
                          : 'translateZ(0px)',
                        boxShadow: isSelected
                          ? `0 0 0 3px ${colors.hex}, 0 0 0 10px ${colors.hex}25, 0 0 30px 10px ${colors.hex}60, 0 16px 24px -4px rgba(0, 0, 0, 0.2)`
                          : viewMode === '3d'
                            ? `0 4px 12px -2px ${colors.hex}15, 0 2px 6px -1px ${colors.hex}05`
                            : '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
                        transformStyle: 'preserve-3d',
                        transition: dragState?.roomId === r.id
                          ? 'none'
                          : 'left 0.3s cubic-bezier(0.16, 1, 0.3, 1), top 0.3s cubic-bezier(0.16, 1, 0.3, 1), width 0.3s cubic-bezier(0.16, 1, 0.3, 1), height 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease, background-color 0.3s ease, border-color 0.3s ease, opacity 0.3s ease',
                      }}
                    >
                      {/* FLAT WALL WINDOWS & DOORS VISUALS (2D Only) */}
                      {viewMode === '2d' && ['North', 'South', 'West', 'East'].flatMap((w) => getRoomWallElements(r, rooms, w)).map((elem) => {
                        let positionStyle = {};
                        if (elem.wall === 'North') {
                          positionStyle = { top: '-2px', left: `${elem.offset}%`, transform: 'translateX(-50%)' };
                        } else if (elem.wall === 'South') {
                          positionStyle = { bottom: '-2px', left: `${elem.offset}%`, transform: 'translateX(-50%)' };
                        } else if (elem.wall === 'West') {
                          positionStyle = { left: '-2px', top: `${elem.offset}%`, transform: 'translateY(-50%)' };
                        } else if (elem.wall === 'East') {
                          positionStyle = { right: '-2px', top: `${elem.offset}%`, transform: 'translateY(-50%)' };
                        }

                        return (
                          <div
                            key={elem.id}
                            className={`absolute font-bold text-[8px] px-1 py-0.5 rounded border leading-none z-20 ${elem.isProjected ? 'opacity-70 border-dashed scale-[0.85]' : ''
                              } ${elem.type === 'Door'
                                ? 'bg-orange-500 text-white border-orange-600'
                                : 'bg-cyan-500 text-white border-cyan-600'
                              }`}
                            style={positionStyle}
                          >
                            {elem.type === 'Door' ? '🚪 D' : '🪟 W'}
                          </div>
                        );
                      })}

                      {/* 3D VERTICAL WALLS WITH MITERED JOINTS & REAL THICKNESS */}
                      {viewMode === '3d' && (
                        <>
                          {/* Floor Texture layer: Gives real wood plank or tiles finish */}
                          <div
                            className="absolute inset-0 rounded-lg pointer-events-none opacity-[0.12]"
                            style={{
                              backgroundImage: r.color === 'blue' || r.color === 'purple'
                                ? 'repeating-linear-gradient(0deg, transparent, transparent 10px, rgba(0,0,0,0.12) 10px, rgba(0,0,0,0.12) 11px), repeating-linear-gradient(90deg, transparent, transparent 40px, rgba(0,0,0,0.06) 40px, rgba(0,0,0,0.06) 41px)' // wood planks
                                : 'repeating-linear-gradient(0deg, transparent, transparent 20px, rgba(0,0,0,0.12) 20px, rgba(0,0,0,0.12) 21px), repeating-linear-gradient(90deg, transparent, transparent 20px, rgba(0,0,0,0.12) 20px, rgba(0,0,0,0.12) 21px)', // ceramic tiles
                              backgroundColor: `${colors.hex}03`,
                            }}
                          />

                          {/* Selected Floor Glow Overlay */}
                          {isSelected && (
                            <div
                              className="absolute inset-0 rounded-lg pointer-events-none animate-pulse"
                              style={{
                                background: `radial-gradient(circle, ${colors.hex}22 0%, ${colors.hex}05 80%)`,
                                border: `3.5px solid ${colors.hex}`,
                                boxShadow: `inset 0 0 15px ${colors.hex}60`,
                                zIndex: 1,
                              }}
                            />
                          )}

                          {/* North Wall Segments (dynamic miter and gaps) */}
                          {(() => {
                            const wallElems = getRoomWallElements(r, rooms, 'North');
                            const segments = getWallSegments(r.width * 60, wallElems);
                            return segments.map((seg, idx) => {
                              const span = seg.endPct - seg.startPct;
                              let left = `${seg.startPct}%`;
                              let width = `${span}%`;

                              if (seg.startPct === 0) {
                                left = "-6px";
                                width = `calc(${span}% + 6px)`;
                              }
                              if (seg.endPct === 100) {
                                width = `calc(${span}% + 6px)`;
                              }
                              if (seg.startPct === 0 && seg.endPct === 100) {
                                width = "calc(100% + 12px)";
                              }

                              if (seg.type === 'solid') {
                                return (
                                  <Wall3D
                                    key={`north-solid-${idx}`}
                                    left={left}
                                    top="-6px"
                                    width={width}
                                    height="12px"
                                    colorHex={colors.hex}
                                  />
                                );
                              } else if (seg.type === 'window') {
                                return (
                                  <React.Fragment key={`north-window-seg-${idx}`}>
                                    {/* Below window (sill) */}
                                    <Wall3D
                                      left={left}
                                      top="-6px"
                                      width={width}
                                      height="12px"
                                      wallHeight={12}
                                      colorHex={colors.hex}
                                    />
                                    {/* Above window (lintel) */}
                                    <Wall3D
                                      left={left}
                                      top="-6px"
                                      width={width}
                                      height="12px"
                                      wallHeight={6}
                                      zOffset={30}
                                      colorHex={colors.hex}
                                    />
                                  </React.Fragment>
                                );
                              } else if (seg.type === 'door') {
                                return (
                                  <React.Fragment key={`north-door-seg-${idx}`}>
                                    {/* Above door (lintel) */}
                                    <Wall3D
                                      left={left}
                                      top="-6px"
                                      width={width}
                                      height="12px"
                                      wallHeight={6}
                                      zOffset={30}
                                      colorHex={colors.hex}
                                    />
                                  </React.Fragment>
                                );
                              }
                              return null;
                            });
                          })()}

                          {/* South Wall Segments (dynamic miter and gaps) */}
                          {(() => {
                            const wallElems = getRoomWallElements(r, rooms, 'South');
                            const segments = getWallSegments(r.width * 60, wallElems);
                            return segments.map((seg, idx) => {
                              const span = seg.endPct - seg.startPct;
                              let left = `${seg.startPct}%`;
                              let width = `${span}%`;

                              if (seg.startPct === 0) {
                                left = "-6px";
                                width = `calc(${span}% + 6px)`;
                              }
                              if (seg.endPct === 100) {
                                width = `calc(${span}% + 6px)`;
                              }
                              if (seg.startPct === 0 && seg.endPct === 100) {
                                width = "calc(100% + 12px)";
                              }

                              if (seg.type === 'solid') {
                                return (
                                  <Wall3D
                                    key={`south-solid-${idx}`}
                                    left={left}
                                    top="calc(100% - 6px)"
                                    width={width}
                                    height="12px"
                                    colorHex={colors.hex}
                                  />
                                );
                              } else if (seg.type === 'window') {
                                return (
                                  <React.Fragment key={`south-window-seg-${idx}`}>
                                    {/* Below window (sill) */}
                                    <Wall3D
                                      left={left}
                                      top="calc(100% - 6px)"
                                      width={width}
                                      height="12px"
                                      wallHeight={12}
                                      colorHex={colors.hex}
                                    />
                                    {/* Above window (lintel) */}
                                    <Wall3D
                                      left={left}
                                      top="calc(100% - 6px)"
                                      width={width}
                                      height="12px"
                                      wallHeight={6}
                                      zOffset={30}
                                      colorHex={colors.hex}
                                    />
                                  </React.Fragment>
                                );
                              } else if (seg.type === 'door') {
                                return (
                                  <React.Fragment key={`south-door-seg-${idx}`}>
                                    {/* Above door (lintel) */}
                                    <Wall3D
                                      left={left}
                                      top="calc(100% - 6px)"
                                      width={width}
                                      height="12px"
                                      wallHeight={6}
                                      zOffset={30}
                                      colorHex={colors.hex}
                                    />
                                  </React.Fragment>
                                );
                              }
                              return null;
                            });
                          })()}

                          {/* West Wall Segments (dynamic gaps, fitting between North/South) */}
                          {(() => {
                            const wallElems = getRoomWallElements(r, rooms, 'West');
                            const segments = getWallSegments(r.height * 47.5, wallElems);
                            return segments.map((seg, idx) => {
                              const span = seg.endPct - seg.startPct;
                              let top = `${seg.startPct}%`;
                              let height = `${span}%`;

                              if (seg.startPct === 0) {
                                top = "6px";
                                height = `calc(${span}% - 6px)`;
                              }
                              if (seg.endPct === 100) {
                                height = `calc(${span}% - 6px)`;
                              }
                              if (seg.startPct === 0 && seg.endPct === 100) {
                                height = "calc(100% - 12px)";
                              }

                              if (seg.type === 'solid') {
                                return (
                                  <Wall3D
                                    key={`west-solid-${idx}`}
                                    left="-6px"
                                    top={top}
                                    width="12px"
                                    height={height}
                                    colorHex={colors.hex}
                                  />
                                );
                              } else if (seg.type === 'window') {
                                return (
                                  <React.Fragment key={`west-window-seg-${idx}`}>
                                    {/* Below window (sill) */}
                                    <Wall3D
                                      left="-6px"
                                      top={top}
                                      width="12px"
                                      height={height}
                                      wallHeight={12}
                                      colorHex={colors.hex}
                                    />
                                    {/* Above window (lintel) */}
                                    <Wall3D
                                      left="-6px"
                                      top={top}
                                      width="12px"
                                      height={height}
                                      wallHeight={6}
                                      zOffset={30}
                                      colorHex={colors.hex}
                                    />
                                  </React.Fragment>
                                );
                              } else if (seg.type === 'door') {
                                return (
                                  <React.Fragment key={`west-door-seg-${idx}`}>
                                    {/* Above door (lintel) */}
                                    <Wall3D
                                      left="-6px"
                                      top={top}
                                      width="12px"
                                      height={height}
                                      wallHeight={6}
                                      zOffset={30}
                                      colorHex={colors.hex}
                                    />
                                  </React.Fragment>
                                );
                              }
                              return null;
                            });
                          })()}

                          {/* East Wall Segments (dynamic gaps, fitting between North/South) */}
                          {(() => {
                            const wallElems = getRoomWallElements(r, rooms, 'East');
                            const segments = getWallSegments(r.height * 47.5, wallElems);
                            return segments.map((seg, idx) => {
                              const span = seg.endPct - seg.startPct;
                              let top = `${seg.startPct}%`;
                              let height = `${span}%`;

                              if (seg.startPct === 0) {
                                top = "6px";
                                height = `calc(${span}% - 6px)`;
                              }
                              if (seg.endPct === 100) {
                                height = `calc(${span}% - 6px)`;
                              }
                              if (seg.startPct === 0 && seg.endPct === 100) {
                                height = "calc(100% - 12px)";
                              }

                              if (seg.type === 'solid') {
                                return (
                                  <Wall3D
                                    key={`east-solid-${idx}`}
                                    left="calc(100% - 6px)"
                                    top={top}
                                    width="12px"
                                    height={height}
                                    colorHex={colors.hex}
                                  />
                                );
                              } else if (seg.type === 'window') {
                                return (
                                  <React.Fragment key={`east-window-seg-${idx}`}>
                                    {/* Below window (sill) */}
                                    <Wall3D
                                      left="calc(100% - 6px)"
                                      top={top}
                                      width="12px"
                                      height={height}
                                      wallHeight={12}
                                      colorHex={colors.hex}
                                    />
                                    {/* Above window (lintel) */}
                                    <Wall3D
                                      left="calc(100% - 6px)"
                                      top={top}
                                      width="12px"
                                      height={height}
                                      wallHeight={6}
                                      zOffset={30}
                                      colorHex={colors.hex}
                                    />
                                  </React.Fragment>
                                );
                              } else if (seg.type === 'door') {
                                return (
                                  <React.Fragment key={`east-door-seg-${idx}`}>
                                    {/* Above door (lintel) */}
                                    <Wall3D
                                      left="calc(100% - 6px)"
                                      top={top}
                                      width="12px"
                                      height={height}
                                      wallHeight={6}
                                      zOffset={30}
                                      colorHex={colors.hex}
                                    />
                                  </React.Fragment>
                                );
                              }
                              return null;
                            });
                          })()}

                          {/* 3D Rendered Doors and Windows directly centered inside wall thickness */}
                          {r.elements.map((elem) => {
                            const isDoor = elem.type === 'Door';

                            // Determine the precise transform based on which wall the element is on
                            let transformStr = '';
                            let styleObj = {
                              position: 'absolute',
                              transformStyle: 'preserve-3d',
                              pointerEvents: 'none',
                              zIndex: 30,
                            };

                            if (elem.wall === 'North') {
                              styleObj.width = '24px';
                              styleObj.height = '30px';
                              styleObj.left = `${elem.offset}%`;
                              styleObj.top = '-30px';
                              styleObj.transformOrigin = 'bottom center';
                              transformStr = 'rotateX(-90deg) translateX(-50%)';
                            } else if (elem.wall === 'South') {
                              styleObj.width = '24px';
                              styleObj.height = '30px';
                              styleObj.left = `${elem.offset}%`;
                              styleObj.bottom = '0px';
                              styleObj.transformOrigin = 'bottom center';
                              transformStr = 'rotateX(-90deg) translateX(-50%)';
                            } else if (elem.wall === 'West') {
                              styleObj.width = '30px';
                              styleObj.height = '24px';
                              styleObj.top = `${elem.offset}%`;
                              styleObj.left = '0px';
                              styleObj.transformOrigin = 'left center';
                              transformStr = 'rotateY(-90deg) translateY(-50%)';
                            } else if (elem.wall === 'East') {
                              styleObj.width = '30px';
                              styleObj.height = '24px';
                              styleObj.top = `${elem.offset}%`;
                              styleObj.right = '0px';
                              styleObj.transformOrigin = 'right center';
                              transformStr = 'rotateY(90deg) translateY(-50%)';
                            }

                            styleObj.transform = transformStr;

                            if (isDoor) {
                              return (
                                <div key={elem.id} style={styleObj}>
                                  {elem.wall === 'North' || elem.wall === 'South' ? (
                                    <>
                                      {/* Wooden door frame */}
                                      <div className="absolute inset-x-0 bottom-0 top-[1px] bg-[#6B4423] border border-[#4A2F18] rounded-t-sm shadow-md" />
                                      {/* Wooden door panel - slightly open for realistic 3D appearance */}
                                      <div
                                        className="absolute inset-x-[2px] bottom-0 top-[3px] bg-[#8B5A2B] border border-[#5C3A1A] rounded-t-sm flex items-center justify-center shadow-lg transition-transform duration-300"
                                        style={{
                                          transformOrigin: 'left',
                                          transform: 'rotateY(-25deg)',
                                        }}
                                      >
                                        <div className="absolute right-0.5 top-1/2 -translate-y-1/2 w-1 h-1 bg-[#FFD60A] rounded-full border border-[#B8860B] shadow-sm" />
                                        <span className="text-[7px] text-white/40 font-bold select-none">🚪</span>
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      {/* West/East Walls */}
                                      <div className={`absolute inset-y-0 ${elem.wall === 'West' ? 'left-0 right-[1px] rounded-r-sm' : 'right-0 left-[1px] rounded-l-sm'} bg-[#6B4423] border border-[#4A2F18] shadow-md`} />
                                      <div
                                        className={`absolute inset-y-[2px] ${elem.wall === 'West' ? 'left-0 right-[3px] rounded-r-sm' : 'right-0 left-[3px] rounded-l-sm'} bg-[#8B5A2B] border border-[#5C3A1A] flex items-center justify-center shadow-lg transition-transform duration-300`}
                                        style={{
                                          transformOrigin: 'top',
                                          transform: 'rotateX(-25deg)',
                                        }}
                                      >
                                        <div className={`absolute ${elem.wall === 'West' ? 'right-1.5' : 'left-1.5'} bottom-1 w-1 h-1 bg-[#FFD60A] rounded-full border border-[#B8860B] shadow-sm`} />
                                        <span className="text-[7px] text-white/40 font-bold select-none">🚪</span>
                                      </div>
                                    </>
                                  )}
                                </div>
                              );
                            } else {
                              // Window
                              return (
                                <div key={elem.id} style={styleObj}>
                                  {elem.wall === 'North' || elem.wall === 'South' ? (
                                    <div className="absolute inset-x-0 bottom-[12px] h-[18px] bg-white border border-olive/25 rounded-sm shadow-md p-[1.5px] flex items-center justify-center">
                                      <div className="relative w-full h-full bg-[#A3E2FD]/20 border border-[#72C6EC]/30 rounded-sm overflow-hidden">
                                        <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/50 to-transparent rotate-45 transform scale-150" />
                                        <div className="absolute inset-0 flex items-center justify-center">
                                          <span className="text-[6px] text-sky-800 font-extrabold opacity-70">🪟</span>
                                        </div>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className={`absolute inset-y-0 ${elem.wall === 'West' ? 'left-[12px]' : 'right-[12px]'} w-[18px] bg-white border border-olive/25 rounded-sm shadow-md p-[1.5px] flex items-center justify-center`}>
                                      <div className="relative w-full h-full bg-[#A3E2FD]/20 border border-[#72C6EC]/30 rounded-sm overflow-hidden">
                                        <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/50 to-transparent rotate-45 transform scale-150" />
                                        <div className="absolute inset-0 flex items-center justify-center">
                                          <span className="text-[6px] text-sky-800 font-extrabold opacity-70">🪟</span>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            }
                          })}
                        </>
                      )}

                      {/* 2D Mode: Render normal flat info and interactive resize handles */}
                      {viewMode === '2d' ? (
                        <>
                          <div className="flex flex-col h-full justify-between pointer-events-none">
                            {/* Room Header Info */}
                            <div className="flex items-start justify-between">
                              <div>
                                <h4 className="font-bold text-[11px] sm:text-xs text-[#3E423A] truncate">{r.name}</h4>
                                <span className="text-[8px] font-mono block text-ink/50">
                                  {(r.width * 1.5).toFixed(1)}m × {(r.height * 1.5).toFixed(1)}m
                                </span>
                              </div>
                              {/* Wireless symbol with power strength */}
                              {linkedEsp && (
                                <div className="flex items-center gap-0.5 text-[#30D158] bg-[#30D158]/10 px-1 py-0.5 rounded text-[8px] font-mono">
                                  <Wifi className="w-2.5 h-2.5" />
                                </div>
                              )}
                            </div>

                            {/* Display live running appliances inside the room */}
                            <div className="flex flex-wrap gap-1 items-end mt-2">
                              {activeAppliances.map((app) => (
                                <span
                                  key={app.id}
                                  title={app.name}
                                  className="w-5 h-5 bg-white border border-[#E4E0D2] rounded-md shadow-sm flex items-center justify-center text-[11px]"
                                >
                                  {app.emoji}
                                </span>
                              ))}
                            </div>

                            {/* Room Footer Status - power consumption */}
                            <div className="flex items-center justify-between mt-auto border-t border-olive/12 pt-1 text-[8px] sm:text-[10px] font-mono text-ink/50">
                              <span>ESP: {linkedEsp?.name.split(' ')[0]}</span>
                              <span className="font-bold text-[#3E423A]">
                                {getRoomPowerDraw(r.id)}W
                              </span>
                            </div>
                          </div>

                          {/* INTERACTIVE RESIZE HANDLES (2D Only when selected) */}
                          {isSelected && (
                            <>
                              {/* East Handle (Resize Width) */}
                              <div
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  const target = e.currentTarget;
                                  if (typeof target.setPointerCapture === 'function') {
                                    target.setPointerCapture(e.pointerId);
                                  }
                                  setResizeState({
                                    roomId: r.id,
                                    axis: 'width',
                                    startWidth: r.width,
                                    startHeight: r.height,
                                    startX: e.clientX,
                                    startY: e.clientY,
                                  });
                                }}
                                onPointerMove={(e) => {
                                  if (!resizeState || resizeState.roomId !== r.id || resizeState.axis !== 'width') return;
                                  e.stopPropagation();
                                  const deltaX = e.clientX - resizeState.startX;
                                  const container = document.getElementById('floorgrid-canvas');
                                  const rect = container ? container.getBoundingClientRect() : { width: 440 };
                                  const scaleFactorX = rect.width / 8;
                                  const rawDelta = deltaX / scaleFactorX;
                                  const deltaGridX = snapToGrid ? Math.round(rawDelta) : Math.round(rawDelta * 100) / 100;
                                  const nextW = Math.max(1, Math.min(8 - r.x, resizeState.startWidth + deltaGridX));
                                  if (nextW !== r.width) {
                                    const hasOverlap = rooms.some(other => {
                                      if (other.id === r.id) return false;
                                      return (r.x < other.x + other.width && r.x + nextW > other.x && r.y < other.y + other.height && r.y + r.height > other.y);
                                    });
                                    if (!hasOverlap) {
                                      setRooms(prev => prev.map(item => item.id === r.id ? { ...item, width: nextW } : item));
                                    }
                                  }
                                }}
                                onPointerUp={(e) => {
                                  if (resizeState && resizeState.roomId === r.id) {
                                    e.stopPropagation();
                                    const target = e.currentTarget;
                                    if (typeof target.releasePointerCapture === 'function') {
                                      target.releasePointerCapture(e.pointerId);
                                    }
                                    const formattedWidth = snapToGrid ? r.width : r.width.toFixed(2);
                                    appendLog(`MAP SIMULATOR: Resized room "${r.name}" width to ${formattedWidth} units (${(r.width * 1.5).toFixed(1)}m)`);
                                    setResizeState(null);
                                  }
                                }}
                                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-6 h-6 bg-white hover:bg-bg-base border-2 border-olive rounded-full shadow-lg z-30 cursor-ew-resize flex items-center justify-center transition-all hover:scale-110 active:scale-95"
                                title="Drag to adjust width"
                              >
                                <span className="text-[10px] font-bold text-ink leading-none">↔</span>
                              </div>

                              {/* South Handle (Resize Height) */}
                              <div
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  const target = e.currentTarget;
                                  if (typeof target.setPointerCapture === 'function') {
                                    target.setPointerCapture(e.pointerId);
                                  }
                                  setResizeState({
                                    roomId: r.id,
                                    axis: 'height',
                                    startWidth: r.width,
                                    startHeight: r.height,
                                    startX: e.clientX,
                                    startY: e.clientY,
                                  });
                                }}
                                onPointerMove={(e) => {
                                  if (!resizeState || resizeState.roomId !== r.id || resizeState.axis !== 'height') return;
                                  e.stopPropagation();
                                  const deltaY = e.clientY - resizeState.startY;
                                  const container = document.getElementById('floorgrid-canvas');
                                  const rect = container ? container.getBoundingClientRect() : { height: 380 };
                                  const scaleFactorY = rect.height / 8;
                                  const rawDelta = deltaY / scaleFactorY;
                                  const deltaGridY = snapToGrid ? Math.round(rawDelta) : Math.round(rawDelta * 100) / 100;
                                  const nextH = Math.max(1, Math.min(8 - r.y, resizeState.startHeight + deltaGridY));
                                  if (nextH !== r.height) {
                                    const hasOverlap = rooms.some(other => {
                                      if (other.id === r.id) return false;
                                      return (r.x < other.x + other.width && r.x + r.width > other.x && r.y < other.y + other.height && r.y + nextH > other.y);
                                    });
                                    if (!hasOverlap) {
                                      setRooms(prev => prev.map(item => item.id === r.id ? { ...item, height: nextH } : item));
                                    }
                                  }
                                }}
                                onPointerUp={(e) => {
                                  if (resizeState && resizeState.roomId === r.id) {
                                    e.stopPropagation();
                                    const target = e.currentTarget;
                                    if (typeof target.releasePointerCapture === 'function') {
                                      target.releasePointerCapture(e.pointerId);
                                    }
                                    const formattedHeight = snapToGrid ? r.height : r.height.toFixed(2);
                                    appendLog(`MAP SIMULATOR: Resized room "${r.name}" height to ${formattedHeight} units (${(r.height * 1.5).toFixed(1)}m)`);
                                    setResizeState(null);
                                  }
                                }}
                                className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-6 h-6 bg-white hover:bg-bg-base border-2 border-olive rounded-full shadow-lg z-30 cursor-ns-resize flex items-center justify-center transition-all hover:scale-110 active:scale-95"
                                title="Drag to adjust height"
                              >
                                <span className="text-[10px] font-bold text-ink leading-none">↕</span>
                              </div>

                              {/* Southeast Corner Handle (Resize both) */}
                              <div
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  const target = e.currentTarget;
                                  if (typeof target.setPointerCapture === 'function') {
                                    target.setPointerCapture(e.pointerId);
                                  }
                                  setResizeState({
                                    roomId: r.id,
                                    axis: 'both',
                                    startWidth: r.width,
                                    startHeight: r.height,
                                    startX: e.clientX,
                                    startY: e.clientY,
                                  });
                                }}
                                onPointerMove={(e) => {
                                  if (!resizeState || resizeState.roomId !== r.id || resizeState.axis !== 'both') return;
                                  e.stopPropagation();
                                  const deltaX = e.clientX - resizeState.startX;
                                  const deltaY = e.clientY - resizeState.startY;
                                  const container = document.getElementById('floorgrid-canvas');
                                  const rect = container ? container.getBoundingClientRect() : { width: 440, height: 380 };

                                  const scaleFactorX = rect.width / 8;
                                  const scaleFactorY = rect.height / 8;

                                  const rawDeltaX = deltaX / scaleFactorX;
                                  const rawDeltaY = deltaY / scaleFactorY;

                                  const deltaGridX = snapToGrid ? Math.round(rawDeltaX) : Math.round(rawDeltaX * 100) / 100;
                                  const deltaGridY = snapToGrid ? Math.round(rawDeltaY) : Math.round(rawDeltaY * 100) / 100;

                                  const nextW = Math.max(1, Math.min(8 - r.x, resizeState.startWidth + deltaGridX));
                                  const nextH = Math.max(1, Math.min(8 - r.y, resizeState.startHeight + deltaGridY));

                                  let finalW = r.width;
                                  let finalH = r.height;

                                  const hasWOverlap = rooms.some(other => {
                                    if (other.id === r.id) return false;
                                    return (r.x < other.x + other.width && r.x + nextW > other.x && r.y < other.y + other.height && r.y + r.height > other.y);
                                  });
                                  if (!hasWOverlap) {
                                    finalW = nextW;
                                  }

                                  const hasHOverlap = rooms.some(other => {
                                    if (other.id === r.id) return false;
                                    return (r.x < other.x + other.width && r.x + finalW > other.x && r.y < other.y + other.height && r.y + nextH > other.y);
                                  });
                                  if (!hasHOverlap) {
                                    finalH = nextH;
                                  }

                                  if (finalW !== r.width || finalH !== r.height) {
                                    setRooms(prev => prev.map(item => {
                                      if (item.id === r.id) {
                                        return { ...item, width: finalW, height: finalH };
                                      }
                                      return item;
                                    }));
                                  }
                                }}
                                onPointerUp={(e) => {
                                  if (resizeState && resizeState.roomId === r.id) {
                                    e.stopPropagation();
                                    const target = e.currentTarget;
                                    if (typeof target.releasePointerCapture === 'function') {
                                      target.releasePointerCapture(e.pointerId);
                                    }
                                    const formattedW = snapToGrid ? r.width : r.width.toFixed(2);
                                    const formattedH = snapToGrid ? r.height : r.height.toFixed(2);
                                    appendLog(`MAP SIMULATOR: Resized room "${r.name}" to ${formattedW}x${formattedH} units`);
                                    setResizeState(null);
                                  }
                                }}
                                className="absolute bottom-0 right-0 translate-x-1/3 translate-y-1/3 w-7 h-7 bg-olive hover:bg-ink border-2 border-white rounded-full shadow-xl z-35 cursor-se-resize flex items-center justify-center transition-all hover:scale-110 active:scale-95"
                                title="Drag to adjust both width and height"
                              >
                                <span className="text-xs font-bold text-white leading-none">↘</span>
                              </div>
                            </>
                          )}
                        </>
                      ) : null}

                      {/* 3D Anchor dot (position read by RAF for flat2D label overlay) */}
                      {viewMode === '3d' && (
                        <div
                          ref={(el) => { anchorRefs.current[r.id] = el; }}
                          className="absolute pointer-events-none"
                          style={{
                            left: '50%',
                            top: '50%',
                            transform: 'translate3d(-50%, -50%, 2px)',
                            transformStyle: 'preserve-3d',
                            zIndex: isSelected ? 150 : 100,
                          }}
                        >
                          <div
                            className={`rounded-full border border-white flex items-center justify-center transition-all duration-300 ${isSelected ? 'w-4 h-4' : 'w-2.5 h-2.5'}`}
                            style={{
                              backgroundColor: isSelected ? `${colors.hex}60` : `${colors.hex}40`,
                            }}
                          >
                            <span
                              className="absolute inset-0 rounded-full opacity-75 animate-ping"
                              style={{ backgroundColor: colors.hex }}
                            />
                            <span
                              className="rounded-full transition-all duration-300"
                              style={{
                                backgroundColor: colors.hex,
                                width: isSelected ? '6px' : '4px',
                                height: isSelected ? '6px' : '4px'
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Floating HUD controls for 3D perspective and label density */}
              {viewMode === '3d' && (
                <div className="absolute top-4 right-4 z-40 flex flex-col gap-2 pointer-events-auto">
                  {/* Label style selectors */}
                  <div className="bg-white/95 backdrop-blur-md border border-olive/15/80 p-1 rounded-xl shadow-md flex items-center gap-1 text-xs">
                    <span className="text-[9px] font-bold text-ink/40 uppercase tracking-wider px-2">Labels:</span>
                    {(['detailed', 'compact', 'hidden']).map((style) => (
                      <button
                        key={style}
                        type="button"
                        onClick={() => {
                          setLabelStyle(style);
                          appendLog(`VIEW SIMULATOR: Changed 3D labels visualization to ${style.toUpperCase()}`);
                        }}
                        className={`px-2 py-1 rounded-lg text-[10px] font-extrabold uppercase transition-all ${labelStyle === style
                          ? 'bg-olive text-white shadow-sm'
                          : 'text-ink/50 hover:text-ink hover:bg-bg-card/40'
                          }`}
                      >
                        {style === 'detailed' ? 'Full' : style === 'compact' ? 'Minimal' : 'Off'}
                      </button>
                    ))}
                  </div>

                  {/* Camera control: zoom in, zoom out, reset view */}
                  <div className="bg-white/95 backdrop-blur-md border border-olive/15/80 p-1 rounded-xl shadow-md flex items-center justify-end gap-1 text-xs self-end">
                    <button
                      type="button"
                      onClick={() => setOrbitZoom(z => Math.min(1.8, z + 0.1))}
                      className="w-7 h-7 flex items-center justify-center rounded-lg text-ink/60 hover:text-ink hover:bg-bg-card/40 font-bold transition-colors"
                      title="Zoom In (or use Mouse Scroll)"
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      onClick={() => setOrbitZoom(z => Math.max(0.4, z - 0.1))}
                      className="w-7 h-7 flex items-center justify-center rounded-lg text-ink/60 hover:text-ink hover:bg-bg-card/40 font-bold transition-colors"
                      title="Zoom Out (or use Mouse Scroll)"
                    >
                      －
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOrbitPitch(58);
                        setOrbitYaw(-38);
                        setOrbitZoom(0.95);
                        appendLog('VIEW SIMULATOR: Reset camera view to default perspective.');
                        addAlert('Camera Reset', 'Returned to standard 3D camera angle.', 'info');
                      }}
                      className="px-2 h-7 flex items-center justify-center rounded-lg text-ink/50 hover:text-ink hover:bg-bg-card/40 font-bold text-[10px] uppercase tracking-wider gap-1 transition-colors"
                      title="Reset Perspective Angle and Zoom"
                    >
                      ↺ Reset
                    </button>
                  </div>
                </div>
              )}

              {/* ─── 2D Flat Label Overlay (outside 3D hierarchy, positions driven by RAF reading anchor dots) ─── */}
              {viewMode === '3d' && labelStyle !== 'hidden' && (
                <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 200 }}>
                  {/* SVG laser stems connecting room floor dots to label cards */}
                  <svg className="absolute inset-0 w-full h-full overflow-visible">
                    {rooms.map(r => {
                      const colors = getColorClasses(r.color);
                      const isSelected = selectedRoomId === r.id;
                      return (
                        <g key={`stem-${r.id}`}>
                          <line
                            ref={(el) => { lineRefs.current[r.id] = el; }}
                            x1="0" y1="0" x2="0" y2="0"
                            stroke={colors.hex}
                            strokeWidth={isSelected ? 2.5 : 1.5}
                            strokeLinecap="round"
                            opacity={0.55}
                          />
                          <circle
                            ref={(el) => { circleRefs.current[r.id] = el; }}
                            cx="0" cy="0" r={isSelected ? 3.5 : 2.5}
                            fill={colors.hex}
                            opacity={0.7}
                          >
                            <animate attributeName="opacity" values="0.7;1;0.7" dur="2s" repeatCount="indefinite" />
                          </circle>
                        </g>
                      );
                    })}
                  </svg>

                  {/* Label cards positioned via RAF */}
                  {rooms.map(r => {
                    const colors = getColorClasses(r.color);
                    const isSelected = selectedRoomId === r.id;
                    const linkedEsp = esps.find(e => e.id === r.espId);
                    const activeAppliances = linkedEsp ? linkedEsp.appliances.filter(app => app.status === 'Active') : [];

                    return (
                      <div
                        key={`label-${r.id}`}
                        ref={(el) => { labelRefs.current[r.id] = el; }}
                        className="absolute pointer-events-auto cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); setSelectedRoomId(r.id); }}
                        style={{
                          left: '50%',
                          top: '50%',
                          transform: 'translate(-50%, -100%)',
                          width: labelStyle === 'compact' ? '120px' : '175px',
                        }}
                      >
                        {labelStyle === 'detailed' ? (
                          <div
                            className="bg-white/95 backdrop-blur-md border border-olive/15/90 p-3 rounded-2xl shadow-[0_12px_24px_rgba(0,0,0,0.14)] flex flex-col gap-1.5 transition-all duration-300 hover:scale-[1.01]"
                            style={{
                              borderColor: isSelected ? colors.hex : undefined,
                              boxShadow: isSelected
                                ? `0 16px 32px -4px ${colors.hex}30, 0 4px 12px -2px ${colors.hex}20, inset 0 0 0 2px ${colors.hex}`
                                : undefined,
                            }}
                          >
                            <div className="flex items-center justify-between gap-1 leading-none">
                              <h4 className="font-bold text-[11px] text-[#3E423A] truncate max-w-[95px]">{r.name}</h4>
                              {linkedEsp ? (
                                <span className="text-[8px] text-[#30D158] bg-[#30D158]/10 px-1 py-0.5 rounded font-mono flex items-center gap-0.5 font-bold">
                                  <Wifi className="w-2 h-2" />
                                </span>
                              ) : (
                                <span className="text-[8px] text-red-500 bg-red-500/10 px-1 py-0.5 rounded font-mono font-bold">
                                  Offline
                                </span>
                              )}
                            </div>
                            <div className="flex items-center justify-between border-t border-b border-olive/10 py-1">
                              <div className="flex gap-0.5 items-center">
                                {activeAppliances.length > 0 ? (
                                  activeAppliances.map((app) => (
                                    <span key={app.id} className="text-sm leading-none" title={app.name}>
                                      {app.emoji}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[9px] text-ink/40 font-mono italic">Idle</span>
                                )}
                              </div>
                              <span className="text-[10px] font-extrabold text-[#3E423A] font-mono bg-bg-base px-1 py-0.5 rounded border border-olive/15/10">
                                {getRoomPowerDraw(r.id)}W
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-[8px] text-ink/40 font-mono">
                              <span>GATEWAY:</span>
                              <span className="font-bold">{linkedEsp ? linkedEsp.ip : '0.0.0.0'}</span>
                            </div>
                          </div>
                        ) : (
                          <div
                            className="bg-white/95 backdrop-blur-md border border-olive/15/80 px-2 py-1.5 rounded-xl shadow-[0_8px_16px_rgba(0,0,0,0.1)] text-center flex flex-col gap-0.5 transition-all duration-300 hover:scale-[1.02]"
                            style={{
                              borderColor: isSelected ? colors.hex : undefined,
                              boxShadow: isSelected
                                ? `0 12px 24px -4px ${colors.hex}30, 0 4px 8px -2px ${colors.hex}20, inset 0 0 0 2px ${colors.hex}`
                                : undefined,
                            }}
                          >
                            <div className="font-extrabold text-[10px] text-[#3E423A] truncate">{r.name}</div>
                            <div
                              className="text-[9px] font-mono font-black"
                              style={{ color: colors.hex }}
                            >
                              {getRoomPowerDraw(r.id)}W
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

            </div>

            {/* Quick interactive canvas tools */}
            <div className="bg-[#FDFBF7] p-4 rounded-2xl border border-[#E4E0D2] flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-ink/50">Select Room to Edit:</span>
                <div className="flex flex-wrap gap-1.5">
                  {rooms.map(r => (
                    <button
                      key={r.id}
                      onClick={() => setSelectedRoomId(r.id)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${selectedRoomId === r.id
                        ? 'bg-[#3E423A] text-white shadow-sm'
                        : 'bg-white text-ink/60 hover:text-ink border border-[#E4E0D2]'
                        }`}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2 w-full xl:w-auto">
                <span className="text-[10px] text-ink/50 font-mono uppercase block xl:text-right font-semibold">Quick-Build Room Templates:</span>
                <div className="flex flex-wrap gap-1.5 xl:justify-end">
                  <button
                    onClick={() => handleAddRoomWithTemplate('Living Lounge 🛋️', 'blue', 4, 3, [
                      { id: `app-tv-${Date.now()}`, name: '4K Smart TV Console', type: 'Light', power: 220, status: 'Active', emoji: '📺' },
                      { id: `app-ac-${Date.now()}`, name: 'Inverter Climate Unit', type: 'Heavy', power: 1200, status: 'Active', emoji: '❄️' }
                    ], 'esp-living')}
                    className="px-3 py-1.5 bg-white hover:bg-[#FDFBF7] text-[#3E423A] font-bold text-[11px] rounded-xl shadow-sm border border-[#E4E0D2] flex items-center gap-1 transition-all"
                  >
                    <span>🛋️ Lounge</span>
                  </button>
                  <button
                    onClick={() => handleAddRoomWithTemplate('Kitchen Hub 🍳', 'orange', 3, 3, [
                      { id: `app-oven-${Date.now()}`, name: 'Induction Cooker', type: 'Heavy', power: 1600, status: 'Active', emoji: '🍳' },
                      { id: `app-fridge-${Date.now()}`, name: 'Smart Refrigerator', type: 'Constant', power: 150, status: 'Active', emoji: '🍺' }
                    ], 'esp-kitchen')}
                    className="px-3 py-1.5 bg-white hover:bg-[#FDFBF7] text-[#3E423A] font-bold text-[11px] rounded-xl shadow-sm border border-[#E4E0D2] flex items-center gap-1 transition-all"
                  >
                    <span>🍳 Kitchen</span>
                  </button>
                  <button
                    onClick={() => handleAddRoomWithTemplate('Master Bedroom 🛏️', 'purple', 3, 3, [
                      { id: `app-bedac-${Date.now()}`, name: 'Bedroom AC Split', type: 'Heavy', power: 850, status: 'Active', emoji: '❄️' },
                      { id: `app-pc-${Date.now()}`, name: 'Computer Workstation', type: 'Heavy', power: 300, status: 'Off', emoji: '💻' }
                    ], 'esp-living')}
                    className="px-3 py-1.5 bg-white hover:bg-[#FDFBF7] text-[#3E423A] font-bold text-[11px] rounded-xl shadow-sm border border-[#E4E0D2] flex items-center gap-1 transition-all"
                  >
                    <span>🛏️ Bedroom</span>
                  </button>
                  <button
                    onClick={() => handleAddRoomWithTemplate('Home Office 💻', 'blue', 3, 2, [
                      { id: `app-pc-${Date.now()}`, name: 'Pro Desktop Rig', type: 'Heavy', power: 450, status: 'Active', emoji: '💻' },
                      { id: `app-lamp-${Date.now()}`, name: 'LED Desk Lamp', type: 'Light', power: 25, status: 'Active', emoji: '💡' }
                    ], 'esp-central')}
                    className="px-3 py-1.5 bg-white hover:bg-[#FDFBF7] text-[#3E423A] font-bold text-[11px] rounded-xl shadow-sm border border-[#E4E0D2] flex items-center gap-1 transition-all"
                  >
                    <span>💻 Office</span>
                  </button>
                  <button
                    onClick={() => handleAddRoomWithTemplate('Luxury Bath 🛁', 'green', 2, 2, [
                      { id: `app-heater-${Date.now()}`, name: 'Electric Water Heater', type: 'Heavy', power: 2000, status: 'Off', emoji: '♨️' }
                    ], 'esp-central')}
                    className="px-3 py-1.5 bg-white hover:bg-[#FDFBF7] text-[#3E423A] font-bold text-[11px] rounded-xl shadow-sm border border-[#E4E0D2] flex items-center gap-1 transition-all"
                  >
                    <span>🛁 Bath</span>
                  </button>
                  <button
                    onClick={handleAddRoom}
                    className="px-3 py-1.5 bg-[#BF5AF2] hover:bg-[#BF5AF2]/90 text-white font-bold text-[11px] rounded-xl shadow-sm flex items-center gap-1 transition-all"
                    title="Build a basic square custom room"
                  >
                    <Plus className="w-3 h-3" />
                    <span>+ Custom</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Interactive room inspector & ESP controls (4 columns) */}
          <div className="xl:col-span-4 space-y-6">

            {/* 1. ROOM POSITION & DIMENSIONS CONTROL PANEL */}
            {selectedRoom ? (
              <div className="bg-[#FAF9F6] border border-[#E4E0D2] rounded-3xl p-5 shadow-sm space-y-5">
                <div className="flex items-center justify-between border-b border-[#E4E0D2] pb-3">
                  <div className="flex items-center gap-2">
                    <Sliders className="w-4.5 h-4.5 text-[#BF5AF2]" />
                    <h3 className="text-sm font-extrabold text-[#3E423A] uppercase tracking-wider font-mono">Room Architect</h3>
                  </div>
                  <button
                    onClick={() => handleDeleteRoom(selectedRoom.id)}
                    className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-all"
                    title="Delete Room"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Name edit */}
                <div>
                  <label className="text-[10px] text-ink/40 font-mono uppercase block mb-1">Room Display Name</label>
                  <input
                    type="text"
                    value={selectedRoom.name}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRooms(prev => prev.map(r => r.id === selectedRoom.id ? { ...r, name: val } : r));
                    }}
                    className="w-full bg-white border border-[#E4E0D2] rounded-xl px-3 py-2 text-xs font-bold text-[#3E423A] focus:ring-2 focus:ring-[#BF5AF2] outline-none"
                  />
                </div>

                {/* Theme color picker */}
                <div>
                  <label className="text-[10px] text-ink/40 font-mono uppercase block mb-2">Room Accent Theme Color</label>
                  <div className="flex flex-wrap gap-2 bg-white border border-[#E4E0D2] rounded-2xl p-3">
                    {[
                      { id: 'blue', hex: '#0A84FF', label: 'Blue' },
                      { id: 'orange', hex: '#FF9500', label: 'Orange' },
                      { id: 'purple', hex: '#BF5AF2', label: 'Purple' },
                      { id: 'green', hex: '#30D158', label: 'Green' },
                      { id: 'red', hex: '#FF453A', label: 'Red' },
                      { id: 'pink', hex: '#FF2D55', label: 'Pink' },
                      { id: 'teal', hex: '#0D9488', label: 'Teal' },
                      { id: 'yellow', hex: '#EAB308', label: 'Yellow' },
                      { id: 'indigo', hex: '#5856D6', label: 'Indigo' },
                      { id: 'cyan', hex: '#06B6D4', label: 'Cyan' }
                    ].map(opt => {
                      const isChosen = selectedRoom.color === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => {
                            setRooms(prev => prev.map(r => r.id === selectedRoom.id ? { ...r, color: opt.id } : r));
                            appendLog(`MAP SIMULATOR: Changed color of "${selectedRoom.name}" to ${opt.label}`);
                          }}
                          className={`w-6 h-6 rounded-full transition-all duration-200 relative focus:outline-none flex items-center justify-center ${isChosen
                            ? 'scale-110 ring-2 ring-offset-2 ring-olive/50 shadow-md'
                            : 'hover:scale-105 active:scale-95 shadow-sm'
                            }`}
                          style={{ backgroundColor: opt.hex }}
                          title={opt.label}
                        >
                          {isChosen && (
                            <span className="w-1.5 h-1.5 bg-white rounded-full"></span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Resize width and height meters */}
                <div className="space-y-3 pt-2 border-t border-olive/12">
                  <span className="text-[10px] text-ink/40 font-mono uppercase block">Dimensions & Area</span>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white rounded-2xl p-3 border border-[#E4E0D2] flex flex-col justify-between">
                      <span className="text-[9px] text-ink/50 font-mono">WIDTH</span>
                      <div className="flex items-center justify-between mt-1 gap-2">
                        <div className="flex items-center bg-[#FDFBF7] px-2 py-1 rounded-lg border border-olive/12 focus-within:ring-1 focus-within:ring-[#BF5AF2] focus-within:border-[#BF5AF2] w-24">
                          <input
                            type="text"
                            value={widthInput}
                            onChange={(e) => handleWidthInputChange(e.target.value)}
                            onBlur={() => handleInputBlur('width')}
                            onKeyDown={(e) => handleInputKeyDown(e, 'width')}
                            className="bg-transparent font-mono font-extrabold text-xs text-[#3E423A] focus:outline-none w-full text-right"
                          />
                          <span className="text-[10px] text-ink/40 font-mono ml-1">m</span>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <button
                            onClick={() => handleResizeRoom('width', -1)}
                            className="w-6 h-6 bg-[#FDFBF7] hover:bg-bg-card/70 active:bg-bg-card rounded flex items-center justify-center font-bold text-xs transition-colors"
                          >
                            -
                          </button>
                          <button
                            onClick={() => handleResizeRoom('width', 1)}
                            className="w-6 h-6 bg-[#FDFBF7] hover:bg-bg-card/70 active:bg-bg-card rounded flex items-center justify-center font-bold text-xs transition-colors"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="bg-white rounded-2xl p-3 border border-[#E4E0D2] flex flex-col justify-between">
                      <span className="text-[9px] text-ink/50 font-mono">LENGTH</span>
                      <div className="flex items-center justify-between mt-1 gap-2">
                        <div className="flex items-center bg-[#FDFBF7] px-2 py-1 rounded-lg border border-olive/12 focus-within:ring-1 focus-within:ring-[#BF5AF2] focus-within:border-[#BF5AF2] w-24">
                          <input
                            type="text"
                            value={heightInput}
                            onChange={(e) => handleHeightInputChange(e.target.value)}
                            onBlur={() => handleInputBlur('height')}
                            onKeyDown={(e) => handleInputKeyDown(e, 'height')}
                            className="bg-transparent font-mono font-extrabold text-xs text-[#3E423A] focus:outline-none w-full text-right"
                          />
                          <span className="text-[10px] text-ink/40 font-mono ml-1">m</span>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <button
                            onClick={() => handleResizeRoom('height', -1)}
                            className="w-6 h-6 bg-[#FDFBF7] hover:bg-bg-card/70 active:bg-bg-card rounded flex items-center justify-center font-bold text-xs transition-colors"
                          >
                            -
                          </button>
                          <button
                            onClick={() => handleResizeRoom('height', 1)}
                            className="w-6 h-6 bg-[#FDFBF7] hover:bg-bg-card/70 active:bg-bg-card rounded flex items-center justify-center font-bold text-xs transition-colors"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. WINDOWS & DOORS PLACEMENT ON WALLS */}
                <div className="space-y-3.5 pt-4 border-t border-olive/12">
                  <span className="text-[10px] text-[#FF9500] font-mono uppercase block font-semibold">Doors & Windows Builder</span>

                  {/* Wall Selector Segmented Control */}
                  <div className="space-y-1">
                    <span className="text-[9px] text-ink/40 font-mono uppercase block font-bold">Select target Wall to build on:</span>
                    <div className="grid grid-cols-4 gap-1 bg-[#FDFBF7] p-1 rounded-xl border border-olive/15/50">
                      {(['North', 'East', 'South', 'West']).map(wall => (
                        <button
                          key={wall}
                          type="button"
                          onClick={() => setSelectedWall(wall)}
                          className={`py-1 text-[10px] font-bold rounded-lg transition-all ${selectedWall === wall
                            ? 'bg-white text-ink shadow-sm border border-olive/15'
                            : 'text-ink/50 hover:text-ink'
                            }`}
                        >
                          {wall === 'North' ? '⬆️ N' : wall === 'East' ? '➡️ E' : wall === 'South' ? '⬇️ S' : '⬅️ W'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Select target Wall & Item to install */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => handleAddWallElement('Door', selectedWall)}
                      className="px-3 py-2 bg-white border border-[#E4E0D2] hover:bg-orange-50 hover:border-orange-100 text-left rounded-xl transition-all flex items-center gap-1.5"
                    >
                      <span className="text-xs font-bold text-ink/70">Add 🚪 Door</span>
                    </button>
                    <button
                      onClick={() => handleAddWallElement('Window', selectedWall)}
                      className="px-3 py-2 bg-white border border-[#E4E0D2] hover:bg-cyan-50 hover:border-cyan-100 text-left rounded-xl transition-all flex items-center gap-1.5"
                    >
                      <span className="text-xs font-bold text-ink/70">Add 🪟 Window</span>
                    </button>
                  </div>

                  {/* List of currently installed structural elements in selected room */}
                  {selectedRoom.elements.length > 0 ? (
                    <div className="space-y-2 mt-2 bg-white p-3 rounded-2xl border border-[#E4E0D2]">
                      <span className="text-[9px] text-ink/40 uppercase font-mono block">Modify element offsets</span>
                      {selectedRoom.elements.map((elem) => (
                        <div key={elem.id} className="flex items-center justify-between gap-3 text-xs border-b border-olive/8 pb-2 last:border-0 last:pb-0">
                          <span className="font-medium text-ink/70 shrink-0">
                            {elem.type === 'Door' ? '🚪' : '🪟'} {elem.wall} Wall
                          </span>

                          {/* Slider offset position */}
                          <input
                            type="range"
                            min="15"
                            max="85"
                            value={elem.offset}
                            onChange={(e) => handleUpdateElementOffset(elem.id, Number(e.target.value))}
                            className="w-full accent-[#BF5AF2] h-1 bg-bg-card/70 rounded-lg appearance-none cursor-pointer"
                          />

                          <button
                            onClick={() => handleDeleteWallElement(elem.id)}
                            className="text-ink/40 hover:text-red-500 p-1 rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[10px] text-ink/40 italic block">No custom doors or windows installed yet. Click above to add!</span>
                  )}
                </div>

                {/* 3. ASSIGNED ROOM ESP HARDWARE */}
                <div className="space-y-3 pt-4 border-t border-[#E4E0D2]">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-ink/40 font-mono uppercase block">Assigned ESP Module</span>
                    <span className="text-[9px] bg-emerald-100 text-emerald-800 font-mono px-1.5 py-0.5 rounded font-bold">WIRED OK</span>
                  </div>

                  {/* ESP Module Info and interactive toggles */}
                  {esps.find(e => e.id === selectedRoom.espId) ? (
                    (() => {
                      const esp = esps.find(e => e.id === selectedRoom.espId);
                      return (
                        <div className="bg-white rounded-2xl p-4 border border-[#E4E0D2] space-y-3">
                          <div className="flex items-center justify-between border-b border-olive/8 pb-2">
                            <div>
                              <span className="font-bold text-xs text-[#3E423A] block">{esp.name}</span>
                              <span className="text-[9px] font-mono text-ink/40">{esp.appliances?.length || 0} appliance(s)</span>
                            </div>
                            <span className="w-2.5 h-2.5 rounded-full bg-[#30D158]" />
                          </div>

                          {/* List of appliances connected to this room ESP */}
                          <div className="space-y-2">
                            <span className="text-[9px] text-ink/40 font-mono uppercase block">Appliance Power Switches</span>

                            {esp.appliances.map((app) => {
                              const isOff = app.status === 'Off';
                              return (
                                <div key={app.id} className="flex items-center justify-between text-xs bg-[#FDFBF7] p-2.5 rounded-xl border border-[#E4E0D2]/40">
                                  <div className="flex items-center gap-2">
                                    <span className="text-base">{app.emoji}</span>
                                    <div>
                                      <span className="font-semibold text-ink block">{app.name}</span>
                                      <span className="text-[9px] text-ink/50 font-mono">{isOff ? 0 : app.power} Watts</span>
                                    </div>
                                  </div>

                                  {/* Direct Apple toggle switch */}
                                  <button
                                    onClick={() => handleToggleAppliance(esp.id, app.id)}
                                    className="p-1 px-2.5 rounded-full text-[9px] font-bold font-mono border transition-all"
                                    style={{
                                      backgroundColor: isOff ? '#E4E0D2' : '#30D158',
                                      borderColor: isOff ? '#D1D1D6' : '#30D158',
                                      color: isOff ? '#6E6E73' : '#FFFFFF',
                                    }}
                                  >
                                    {isOff ? 'OFF' : 'ON'}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                    <span className="text-xs text-red-500">Error: No connected ESP detected for this room.</span>
                  )}
                </div>

              </div>
            ) : (
              <div className="bg-bg-base rounded-3xl p-6 border border-[#E4E0D2] text-center">
                <span className="text-ink/40 text-xs italic">Please select a room on the floor plan map to customize and control its ESP.</span>
              </div>
            )}

          </div>

        </div>

      </div>

      {/* Footer info strip */}
      <div className="border-t border-[#FDFBF7] pt-4 mt-8 flex flex-col sm:flex-row sm:items-center justify-between text-xs text-ink/50 gap-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-clay" />
          <span>Floor plan is local to this browser and is not saved yet.</span>
        </div>
        <div className="flex items-center gap-1.5 text-ink/40">
          <span>Rooms and doors feed occupancy once the layout is wired up.</span>
        </div>
      </div>
    </div>
  );
}

function Wall3D({
  left,
  top,
  width,
  height,
  wallHeight = 36,
  zOffset = 0,
  colorHex,
}) {
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left,
        top,
        width,
        height,
        transformStyle: 'preserve-3d',
        transform: zOffset > 0 ? `translateZ(${zOffset}px)` : undefined,
      }}
    >
      {/* 1. TOP FACE (Wall cap / Plaster coping) */}
      <div
        className="absolute inset-0 border border-black/[0.12]"
        style={{
          backgroundColor: '#EAEAE5',
          transform: `translateZ(${wallHeight}px)`,
          boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
        }}
      />

      {/* 2. FRONT FACE (Facing South / towards Camera) */}
      <div
        className="absolute left-0 right-0 bottom-0 border-t border-black/[0.12]"
        style={{
          height: `${wallHeight}px`,
          transformOrigin: 'bottom',
          transform: 'rotateX(-90deg)',
          backgroundColor: '#A8A49C',
          backgroundImage: 'linear-gradient(to top, rgba(255,255,255,0.1), rgba(0,0,0,0.05))',
        }}
      />

      {/* 3. BACK FACE (Facing North / away from Camera) */}
      <div
        className="absolute left-0 right-0 top-0 border-b border-black/[0.12]"
        style={{
          height: `${wallHeight}px`,
          transformOrigin: 'top',
          transform: 'rotateX(90deg)',
          backgroundColor: '#959088',
          backgroundImage: 'linear-gradient(to top, rgba(0,0,0,0.1), rgba(0,0,0,0.05))',
        }}
      />

      {/* 4. LEFT FACE (Facing West) */}
      <div
        className="absolute top-0 bottom-0 left-0 border-r border-black/[0.12]"
        style={{
          width: `${wallHeight}px`,
          transformOrigin: 'left',
          transform: 'rotateY(-90deg)',
          backgroundColor: '#9E9A92',
          backgroundImage: 'linear-gradient(to right, rgba(0,0,0,0.1), rgba(255,255,255,0.05))',
        }}
      />

      {/* 5. RIGHT FACE (Facing East) */}
      <div
        className="absolute top-0 bottom-0 right-0 border-l border-black/[0.12]"
        style={{
          width: `${wallHeight}px`,
          transformOrigin: 'right',
          transform: 'rotateY(90deg)',
          backgroundColor: '#8C8880',
          backgroundImage: 'linear-gradient(to left, rgba(0,0,0,0.1), rgba(255,255,255,0.05))',
        }}
      />
    </div>
  );
}
