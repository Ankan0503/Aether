import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import * as THREE from 'three';
import {
  Box,
  DoorOpen,
  Grid3X3,
  MonitorUp,
  Move,
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
  Trash2,
  Zap
} from 'lucide-react';
import { cn } from '../lib/utils';

type LayoutDevice = {
  mac_address: string;
  device_alias: string;
  device_type: 'GATEWAY' | 'SUBNODE';
  role: string;
  is_active?: boolean;
  last_seen?: string | null;
};

type DoorWall = 'top' | 'right' | 'bottom' | 'left';

type RoomDoor = {
  id: string;
  wall: DoorWall;
  offset: number;
  width: number;
};

type RoomLayout = {
  id?: string;
  name: string;
  floor?: number;
  grid_x: number;
  grid_y: number;
  grid_w: number;
  grid_h: number;
  mapped_device_mac?: string | null;
  devices?: LayoutDevice[];
  doors?: RoomDoor[];
};

interface DigitalTwinViewProps {
  token: string;
  meshId: string;
  liveTelemetry: any;
  addToast: (message: string, icon: any) => void;
}

const GRID_COLS = 16;
const GRID_ROWS = 12;
const CELL_SIZE = 34;
const WALL_HEIGHT = 0.66;
const WALL_THICKNESS = 0.08;
const floorLabel = (floor: number) => `Floor ${floor + 1}`;

const starterRooms: RoomLayout[] = [
  { name: 'Kitchen', floor: 0, grid_x: 0, grid_y: 0, grid_w: 5, grid_h: 4, mapped_device_mac: null, doors: [{ id: 'kitchen-door', wall: 'bottom', offset: 0.5, width: 0.32 }] },
  { name: 'Living Room', floor: 0, grid_x: 5, grid_y: 0, grid_w: 6, grid_h: 5, mapped_device_mac: null, doors: [{ id: 'living-door', wall: 'left', offset: 0.52, width: 0.26 }] },
  { name: 'Utility', floor: 0, grid_x: 0, grid_y: 4, grid_w: 4, grid_h: 4, mapped_device_mac: null, doors: [{ id: 'utility-door', wall: 'top', offset: 0.45, width: 0.3 }] },
];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const createDoor = (wall: DoorWall = 'bottom'): RoomDoor => ({
  id: `door-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  wall,
  offset: 0.5,
  width: 0.28,
});
const normalizeDoors = (room: RoomLayout): RoomDoor[] => {
  if (Array.isArray(room.doors)) {
    return room.doors.map((door, index) => ({
      id: door.id || `${room.id || room.name}-door-${index}`,
      wall: door.wall || 'bottom',
      offset: clamp(Number(door.offset ?? 0.5), 0.08, 0.92),
      width: clamp(Number(door.width ?? 0.28), 0.12, 0.75),
    }));
  }
  return [createDoor('bottom')];
};
const resizeHandles = [
  { dir: 'n', className: 'left-1/2 top-[-6px] h-3 w-10 -translate-x-1/2 cursor-ns-resize rounded-full' },
  { dir: 's', className: 'left-1/2 bottom-[-6px] h-3 w-10 -translate-x-1/2 cursor-ns-resize rounded-full' },
  { dir: 'e', className: 'right-[-6px] top-1/2 h-10 w-3 -translate-y-1/2 cursor-ew-resize rounded-full' },
  { dir: 'w', className: 'left-[-6px] top-1/2 h-10 w-3 -translate-y-1/2 cursor-ew-resize rounded-full' },
  { dir: 'ne', className: 'right-[-7px] top-[-7px] h-4 w-4 cursor-nesw-resize rounded-full' },
  { dir: 'nw', className: 'left-[-7px] top-[-7px] h-4 w-4 cursor-nwse-resize rounded-full' },
  { dir: 'se', className: 'right-[-7px] bottom-[-7px] h-4 w-4 cursor-nwse-resize rounded-full' },
  { dir: 'sw', className: 'left-[-7px] bottom-[-7px] h-4 w-4 cursor-nesw-resize rounded-full' },
];
const doorStyle = (room: RoomLayout, door: RoomDoor): React.CSSProperties => {
  const roomW = room.grid_w * CELL_SIZE;
  const roomH = room.grid_h * CELL_SIZE;
  const doorPixels = Math.max((door.wall === 'top' || door.wall === 'bottom' ? roomW : roomH) * door.width, 20);
  const offset = clamp(door.offset, 0.08, 0.92);

  if (door.wall === 'top') {
    return { top: -8, left: offset * roomW - doorPixels / 2, width: doorPixels };
  }
  if (door.wall === 'bottom') {
    return { bottom: -8, left: offset * roomW - doorPixels / 2, width: doorPixels };
  }
  if (door.wall === 'left') {
    return { left: -8, top: offset * roomH - doorPixels / 2, height: doorPixels };
  }
  return { right: -8, top: offset * roomH - doorPixels / 2, height: doorPixels };
};

const roomEspNames = (room: RoomLayout, devices: LayoutDevice[]) => {
  const names = (room.devices || [])
    .map(device => device.device_alias || device.mac_address)
    .filter(Boolean);

  if (names.length) return names.join(', ');
  const mappedDevice = devices.find(device => device.mac_address === room.mapped_device_mac);
  if (mappedDevice) return mappedDevice.device_alias || mappedDevice.mac_address;
  return room.mapped_device_mac ? room.mapped_device_mac : 'No ESP mapped';
};

const isFaultStatus = (status: unknown) => {
  const normalized = String(status || '').toUpperCase();
  return normalized.includes('TRIP') || normalized.includes('FAULT') || normalized.includes('LEAK') || normalized.includes('FIRE');
};

export const DigitalTwinView = ({ token, meshId, liveTelemetry, addToast }: DigitalTwinViewProps) => {
  const [mode, setMode] = useState<'editor' | 'hud'>('editor');
  const [rooms, setRooms] = useState<RoomLayout[]>([]);
  const [unmappedDevices, setUnmappedDevices] = useState<LayoutDevice[]>([]);
  const [selectedFloor, setSelectedFloor] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const dragState = useRef<null | {
    index: number;
    type: 'move' | 'resize' | 'door';
    resizeDir?: string;
    doorId?: string;
    startX: number;
    startY: number;
    room: RoomLayout;
  }>(null);

  const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000';

  const allDevices = useMemo(() => {
    const mapped = rooms.flatMap(room => room.devices || []);
    const byMac = new Map<string, LayoutDevice>();
    [...mapped, ...unmappedDevices].forEach(device => byMac.set(device.mac_address, device));
    return Array.from(byMac.values());
  }, [rooms, unmappedDevices]);

  const floorOptions = useMemo(() => {
    const floors = new Set(rooms.map(room => Number(room.floor ?? 0)));
    floors.add(selectedFloor);
    return Array.from(floors).sort((a, b) => a - b);
  }, [rooms, selectedFloor]);

  const visibleRoomEntries = useMemo(
    () => rooms
      .map((room, index) => ({ room, index }))
      .filter(({ room }) => Number(room.floor ?? 0) === selectedFloor),
    [rooms, selectedFloor]
  );

  const selectedRoom = rooms[selectedIndex];

  const authHeaders = (): HeadersInit => {
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  };

  const loadLayout = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/layout/?include_devices=1`, { headers: authHeaders() });
      if (!res.ok) {
        setRooms(starterRooms);
        return;
      }
      const data = await res.json();
      const loadedRooms = Array.isArray(data.rooms) ? data.rooms : [];
      const nextRooms = (loadedRooms.length ? loadedRooms : starterRooms).map((room: RoomLayout) => ({ ...room, floor: Number(room.floor ?? 0), doors: normalizeDoors(room) }));
      setRooms(nextRooms);
      setUnmappedDevices(Array.isArray(data.unmapped_devices) ? data.unmapped_devices : []);
      setSelectedFloor(Number(nextRooms[0]?.floor ?? 0));
      setSelectedIndex(0);
    } catch (err) {
      console.error('Failed to load digital twin layout:', err);
      setRooms(starterRooms);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadLayout();
  }, [token]);

  const saveLayout = async () => {
    setIsSaving(true);
    try {
      const payload = {
        rooms: rooms.map(room => ({
          id: room.id,
          name: room.name,
          floor: Number(room.floor ?? 0),
          grid_x: room.grid_x,
          grid_y: room.grid_y,
          grid_w: room.grid_w,
          grid_h: room.grid_h,
          mapped_device_mac: room.mapped_device_mac || null,
          doors: normalizeDoors(room),
        })),
      };
      const res = await fetch(`${apiBaseUrl}/api/layout/`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Layout save failed');
      const data = await res.json();
      setRooms((data.rooms || rooms).map((room: RoomLayout) => ({ ...room, floor: Number(room.floor ?? 0), doors: normalizeDoors(room) })));
      setUnmappedDevices(data.unmapped_devices || []);
      addToast('Digital twin layout saved', Save);
    } catch (err) {
      console.error('Failed to save digital twin layout:', err);
      addToast('Layout save failed', ShieldAlert);
    } finally {
      setIsSaving(false);
    }
  };

  const updateRoom = (index: number, patch: Partial<RoomLayout>) => {
    setRooms(prev => prev.map((room, i) => i === index ? { ...room, ...patch } : room));
  };

  const addFloor = () => {
    const nextFloor = floorOptions.length ? Math.max(...floorOptions) + 1 : 0;
    setSelectedFloor(nextFloor);
    setSelectedIndex(-1);
  };

  const addRoom = () => {
    setRooms(prev => {
      const next = [
        ...prev,
        {
          name: `Room ${prev.length + 1}`,
          floor: selectedFloor,
          grid_x: 1,
          grid_y: 1,
          grid_w: 4,
          grid_h: 3,
          mapped_device_mac: null,
          doors: [createDoor('bottom')],
        },
      ];
      setSelectedIndex(next.length - 1);
      return next;
    });
  };

  const removeSelectedRoom = () => {
    if (!rooms[selectedIndex]) return;
    setRooms(prev => prev.filter((_, index) => index !== selectedIndex));
    setSelectedIndex(index => Math.max(0, index - 1));
    addToast('Room removed from layout draft', Trash2);
  };

  const updateDoor = (roomIndex: number, doorId: string, patch: Partial<RoomDoor>) => {
    const room = rooms[roomIndex];
    if (!room) return;
    updateRoom(roomIndex, {
      doors: normalizeDoors(room).map(door => door.id === doorId ? {
        ...door,
        ...patch,
        offset: patch.offset !== undefined ? clamp(Number(patch.offset), 0.08, 0.92) : door.offset,
        width: patch.width !== undefined ? clamp(Number(patch.width), 0.12, 0.75) : door.width,
      } : door),
    });
  };

  const setDoorCount = (roomIndex: number, count: number) => {
    const room = rooms[roomIndex];
    if (!room) return;
    const nextCount = clamp(count, 0, 8);
    const current = normalizeDoors(room);
    const nextDoors = [...current];
    while (nextDoors.length < nextCount) nextDoors.push(createDoor(['bottom', 'right', 'top', 'left'][nextDoors.length % 4] as DoorWall));
    updateRoom(roomIndex, { doors: nextDoors.slice(0, nextCount) });
  };

  const removeDoor = (roomIndex: number, doorId: string) => {
    const room = rooms[roomIndex];
    if (!room) return;
    updateRoom(roomIndex, { doors: normalizeDoors(room).filter(door => door.id !== doorId) });
  };

  const pointerToGridDelta = (startX: number, startY: number, x: number, y: number) => ({
    dx: Math.round((x - startX) / CELL_SIZE),
    dy: Math.round((y - startY) / CELL_SIZE),
  });

  const onPointerMove = (event: PointerEvent) => {
    const state = dragState.current;
    if (!state) return;
    const { dx, dy } = pointerToGridDelta(state.startX, state.startY, event.clientX, event.clientY);
    if (state.type === 'move') {
      updateRoom(state.index, {
        grid_x: clamp(state.room.grid_x + dx, 0, GRID_COLS - state.room.grid_w),
        grid_y: clamp(state.room.grid_y + dy, 0, GRID_ROWS - state.room.grid_h),
      });
      return;
    }

    if (state.type === 'resize') {
      const dir = state.resizeDir || 'se';
      let nextX = state.room.grid_x;
      let nextY = state.room.grid_y;
      let nextW = state.room.grid_w;
      let nextH = state.room.grid_h;

      if (dir.includes('e')) nextW = clamp(state.room.grid_w + dx, 2, GRID_COLS - state.room.grid_x);
      if (dir.includes('s')) nextH = clamp(state.room.grid_h + dy, 2, GRID_ROWS - state.room.grid_y);
      if (dir.includes('w')) {
        nextX = clamp(state.room.grid_x + dx, 0, state.room.grid_x + state.room.grid_w - 2);
        nextW = state.room.grid_w + (state.room.grid_x - nextX);
      }
      if (dir.includes('n')) {
        nextY = clamp(state.room.grid_y + dy, 0, state.room.grid_y + state.room.grid_h - 2);
        nextH = state.room.grid_h + (state.room.grid_y - nextY);
      }

      updateRoom(state.index, { grid_x: nextX, grid_y: nextY, grid_w: nextW, grid_h: nextH });
      return;
    }

    if (state.type === 'door' && state.doorId) {
      const roomPixelW = state.room.grid_w * CELL_SIZE;
      const roomPixelH = state.room.grid_h * CELL_SIZE;
      const doors = normalizeDoors(state.room).map(door => {
        if (door.id !== state.doorId) return door;
        const horizontal = door.wall === 'top' || door.wall === 'bottom';
        const delta = horizontal ? (event.clientX - state.startX) / roomPixelW : (event.clientY - state.startY) / roomPixelH;
        return { ...door, offset: clamp(door.offset + delta, 0.08, 0.92) };
      });
      updateRoom(state.index, { doors });
    }
  };

  const clearDrag = () => {
    dragState.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', clearDrag);
  };

  const startDrag = (
    event: React.PointerEvent,
    index: number,
    type: 'move' | 'resize' | 'door',
    options: { resizeDir?: string; doorId?: string } = {}
  ) => {
    event.preventDefault();
    setSelectedIndex(index);
    dragState.current = {
      index,
      type,
      ...options,
      startX: event.clientX,
      startY: event.clientY,
      room: rooms[index],
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', clearDrag);
  };

  useEffect(() => clearDrag, []);

  useEffect(() => {
    if (!rooms.length) {
      setSelectedIndex(0);
      return;
    }
    if (!rooms[selectedIndex] || Number(rooms[selectedIndex].floor ?? 0) !== selectedFloor) {
      setSelectedIndex(visibleRoomEntries[0]?.index ?? -1);
    }
  }, [rooms, selectedFloor, selectedIndex, visibleRoomEntries]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6 pb-20"
    >
      <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-5">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-2 rounded-2xl bg-olive/5 border border-olive/10 text-olive text-[10px] font-black uppercase tracking-widest mb-4">
            <Box size={14} />
            Digital Twin
          </div>
          <h2 className="text-2xl sm:text-3xl md:text-5xl font-display font-semibold text-ink leading-tight">Floor Plan Editor & Safety HUD</h2>
          <p className="text-sm text-ink/50 mt-3 max-w-3xl">Design rooms, bind ESP-NOW devices, then view a live 2.5D twin driven by telemetry.</p>
        </div>
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 w-full xl:w-auto">
          <div className="p-1 bg-bg-card/60 rounded-2xl border border-olive/10 flex gap-1 overflow-x-auto no-scrollbar w-full sm:w-auto">
            {floorOptions.map(floor => (
              <button
                key={floor}
                onClick={() => setSelectedFloor(floor)}
                className={cn(
                  'shrink-0 px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all',
                  selectedFloor === floor ? 'bg-white text-olive shadow-sm' : 'text-ink/40 hover:text-ink'
                )}
              >
                {floorLabel(floor)}
              </button>
            ))}
            <button
              onClick={addFloor}
              className="shrink-0 h-10 w-10 self-center rounded-xl bg-white text-olive border border-olive/10 flex items-center justify-center"
              title="Add floor"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="p-1 bg-bg-card/60 rounded-2xl border border-olive/10 grid grid-cols-2 sm:flex gap-1 w-full sm:w-auto">
            {[
              { id: 'editor', Icon: Grid3X3, label: 'Editor' },
              { id: 'hud', Icon: MonitorUp, label: 'HUD' },
            ].map(({ id, Icon, label }) => (
              <button
                key={String(id)}
                onClick={() => setMode(id as 'editor' | 'hud')}
                className={cn(
                  'px-4 sm:px-5 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all',
                  mode === id ? 'bg-white text-olive shadow-sm' : 'text-ink/40 hover:text-ink'
                )}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
          <button onClick={loadLayout} className="px-4 py-3 rounded-2xl bg-white border border-olive/10 text-ink/50 hover:text-olive transition-all flex justify-center">
            <RotateCcw size={16} />
          </button>
          <button
            onClick={saveLayout}
            disabled={isSaving}
            className="px-6 py-3 rounded-2xl bg-ink text-white text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-3 shadow-lg shadow-ink/10 hover:bg-olive transition-all disabled:opacity-50"
          >
            <Save size={15} />
            {isSaving ? 'Saving' : 'Save Layout'}
          </button>
        </div>
      </div>

      {mode === 'editor' ? (
        <div className="grid grid-cols-1 2xl:grid-cols-[1fr_360px] gap-6">
          <div className="bg-white rounded-[1.75rem] sm:rounded-[2.5rem] border border-olive/10 shadow-sm p-3 sm:p-5 overflow-x-auto">
            <div className="mb-4 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 sm:flex-wrap sm:overflow-visible">
                {visibleRoomEntries.map(({ room, index }) => (
                  <button
                    key={room.id || `${room.name}-${index}-tab`}
                    onClick={() => setSelectedIndex(index)}
                    className={cn(
                      'shrink-0 px-3 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all',
                      selectedIndex === index
                        ? 'bg-olive text-white border-olive'
                        : 'bg-bg-card/30 text-ink/45 border-olive/5 hover:text-ink'
                    )}
                  >
                    {room.name}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-ink/35 overflow-x-auto no-scrollbar">
                <span className="rounded-xl bg-bg-card/40 px-3 py-2">{floorLabel(selectedFloor)}</span>
                <span className="rounded-xl bg-bg-card/40 px-3 py-2">{visibleRoomEntries.length} Rooms</span>
                <span className="rounded-xl bg-bg-card/40 px-3 py-2">{allDevices.length} Devices</span>
              </div>
            </div>
            <div
              className="relative rounded-[1.5rem] sm:rounded-[2rem] border border-olive/10 bg-bg-base overflow-hidden touch-none"
              style={{
                width: GRID_COLS * CELL_SIZE,
                height: GRID_ROWS * CELL_SIZE,
                backgroundImage:
                  'linear-gradient(rgba(96,108,56,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(96,108,56,0.10) 1px, transparent 1px)',
                backgroundSize: `${CELL_SIZE}px ${CELL_SIZE}px`,
              }}
            >
              {visibleRoomEntries.map(({ room, index }) => {
                const isSelected = selectedIndex === index;
                const mappedDevice = allDevices.find(device => device.mac_address === room.mapped_device_mac);
                const doors = normalizeDoors(room);
                return (
                  <div
                    key={room.id || `${room.name}-${index}`}
                    onPointerDown={(event) => startDrag(event, index, 'move')}
                    className={cn(
                      'absolute rounded-2xl border bg-white shadow-sm cursor-grab active:cursor-grabbing p-2 sm:p-3 transition-colors select-none',
                      isSelected ? 'border-olive ring-4 ring-olive/10' : 'border-olive/15 hover:border-olive/35'
                    )}
                    style={{
                      left: room.grid_x * CELL_SIZE,
                      top: room.grid_y * CELL_SIZE,
                      width: room.grid_w * CELL_SIZE,
                      height: room.grid_h * CELL_SIZE,
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-bold text-ink text-xs sm:text-sm truncate">{room.name}</div>
                        <div className="mt-1 text-[9px] font-black uppercase tracking-widest text-ink/30 truncate">
                          {mappedDevice?.device_alias || 'No device mapped'}
                        </div>
                      </div>
                      <Move size={14} className="text-ink/25 shrink-0" />
                    </div>
                    {doors.map((door, doorIndex) => (
                      <button
                        key={door.id}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          startDrag(event, index, 'door', { doorId: door.id });
                        }}
                        className={cn(
                          'absolute z-20 flex items-center justify-center rounded-lg bg-olive text-white shadow-md shadow-olive/15 border border-white/70 cursor-grab active:cursor-grabbing',
                          door.wall === 'top' || door.wall === 'bottom' ? 'h-4' : 'w-4'
                        )}
                        style={doorStyle(room, door)}
                        title={`Drag door ${doorIndex + 1}`}
                      >
                        <DoorOpen size={10} />
                      </button>
                    ))}
                    {mappedDevice && (
                      <div className="absolute right-3 top-12 rounded-xl bg-olive/10 px-2 py-1 text-[8px] font-black uppercase tracking-widest text-olive">
                        {mappedDevice.device_type}
                      </div>
                    )}
                    {isSelected && resizeHandles.map(handle => (
                      <button
                        key={handle.dir}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          startDrag(event, index, 'resize', { resizeDir: handle.dir });
                        }}
                        className={cn('absolute z-30 bg-white border border-olive/40 shadow-sm', handle.className)}
                        title={`Resize ${handle.dir}`}
                      />
                    ))}
                  </div>
                );
              })}
              {!visibleRoomEntries.length && (
                <div className="absolute inset-0 flex items-center justify-center text-center">
                  <div>
                    <div className="text-sm font-bold text-ink/45">{floorLabel(selectedFloor)} has no rooms yet.</div>
                    <button
                      onClick={addRoom}
                      className="mt-4 rounded-2xl bg-olive text-white px-5 py-3 text-[9px] font-black uppercase tracking-widest"
                    >
                      Add Room
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <aside className="bg-white rounded-[1.75rem] sm:rounded-[2.5rem] border border-olive/10 shadow-sm p-4 sm:p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-widest text-ink">Room Inspector</h3>
              <button onClick={addRoom} className="h-10 w-10 rounded-xl bg-olive text-white flex items-center justify-center" title="Add room">
                <Plus size={16} />
              </button>
            </div>

            {selectedRoom && (
              <div className="space-y-4">
                <label className="block">
                  <span className="text-[9px] font-black uppercase tracking-widest text-ink/35">Room Name</span>
                  <input
                    value={selectedRoom.name}
                    onChange={(event) => updateRoom(selectedIndex, { name: event.target.value })}
                    className="mt-2 w-full rounded-2xl border border-olive/10 bg-bg-card/20 px-4 py-3 text-sm font-bold text-ink outline-none focus:border-olive/40"
                  />
                </label>

                <label className="block">
                  <span className="text-[9px] font-black uppercase tracking-widest text-ink/35">Floor</span>
                  <select
                    value={Number(selectedRoom.floor ?? 0)}
                    onChange={(event) => {
                      const floor = Number(event.target.value);
                      updateRoom(selectedIndex, { floor });
                      setSelectedFloor(floor);
                    }}
                    className="mt-2 w-full rounded-2xl border border-olive/10 bg-bg-card/20 px-4 py-3 text-sm font-bold text-ink outline-none focus:border-olive/40"
                  >
                    {floorOptions.map(floor => (
                      <option key={floor} value={floor}>{floorLabel(floor)}</option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="text-[9px] font-black uppercase tracking-widest text-ink/35">Mapped Device</span>
                  <select
                    value={selectedRoom.mapped_device_mac || ''}
                    onChange={(event) => updateRoom(selectedIndex, { mapped_device_mac: event.target.value || null })}
                    className="mt-2 w-full rounded-2xl border border-olive/10 bg-bg-card/20 px-4 py-3 text-sm font-bold text-ink outline-none focus:border-olive/40"
                  >
                    <option value="">Unmapped</option>
                    {allDevices.map(device => (
                      <option key={device.mac_address} value={device.mac_address}>
                        {device.device_alias} - {device.mac_address}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {(['grid_x', 'grid_y', 'grid_w', 'grid_h'] as const).map(key => (
                    <label key={key}>
                      <span className="text-[8px] font-black uppercase tracking-widest text-ink/30">{key.replace('grid_', '')}</span>
                      <input
                        type="number"
                        value={selectedRoom[key]}
                        onChange={(event) => updateRoom(selectedIndex, { [key]: Number(event.target.value) } as Partial<RoomLayout>)}
                        className="mt-1 w-full rounded-xl border border-olive/10 bg-white px-2 py-2 text-xs font-bold text-ink"
                      />
                    </label>
                  ))}
                </div>

                <div className="rounded-2xl bg-bg-card/25 border border-olive/5 p-3 sm:p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[9px] font-black uppercase tracking-widest text-ink/35">Doors</div>
                      <div className="text-xs font-bold text-ink/50 mt-1">Drag doors on room edges or set exact placement.</div>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={8}
                      value={normalizeDoors(selectedRoom).length}
                      onChange={(event) => setDoorCount(selectedIndex, Number(event.target.value))}
                      className="w-16 rounded-xl border border-olive/10 bg-white px-3 py-2 text-sm font-black text-ink"
                    />
                  </div>

                  <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                    {normalizeDoors(selectedRoom).map((door, doorIndex) => (
                      <div key={door.id} className="rounded-2xl bg-white border border-olive/10 p-3 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-olive">
                            <DoorOpen size={14} />
                            Door {doorIndex + 1}
                          </div>
                          <button
                            onClick={() => removeDoor(selectedIndex, door.id)}
                            className="h-8 w-8 rounded-xl bg-danger/10 text-danger flex items-center justify-center"
                            title="Remove door"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-[1fr_80px_80px] gap-2">
                          <label>
                            <span className="text-[8px] font-black uppercase tracking-widest text-ink/30">Wall</span>
                            <select
                              value={door.wall}
                              onChange={(event) => updateDoor(selectedIndex, door.id, { wall: event.target.value as DoorWall })}
                              className="mt-1 w-full rounded-xl border border-olive/10 bg-bg-card/20 px-2 py-2 text-xs font-bold text-ink"
                            >
                              {(['top', 'right', 'bottom', 'left'] as DoorWall[]).map(wall => (
                                <option key={wall} value={wall}>{wall}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span className="text-[8px] font-black uppercase tracking-widest text-ink/30">Pos</span>
                            <input
                              type="number"
                              min={8}
                              max={92}
                              value={Math.round(door.offset * 100)}
                              onChange={(event) => updateDoor(selectedIndex, door.id, { offset: Number(event.target.value) / 100 })}
                              className="mt-1 w-full rounded-xl border border-olive/10 bg-bg-card/20 px-2 py-2 text-xs font-bold text-ink"
                            />
                          </label>
                          <label>
                            <span className="text-[8px] font-black uppercase tracking-widest text-ink/30">Width</span>
                            <input
                              type="number"
                              min={12}
                              max={75}
                              value={Math.round(door.width * 100)}
                              onChange={(event) => updateDoor(selectedIndex, door.id, { width: Number(event.target.value) / 100 })}
                              className="mt-1 w-full rounded-xl border border-olive/10 bg-bg-card/20 px-2 py-2 text-xs font-bold text-ink"
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <button
                    onClick={addRoom}
                    className="rounded-2xl bg-olive text-white px-4 py-3 text-[9px] font-black uppercase tracking-widest flex items-center justify-center gap-2"
                  >
                    <Plus size={14} />
                    Add
                  </button>
                  <button
                    onClick={removeSelectedRoom}
                    disabled={rooms.length <= 1}
                    className="rounded-2xl bg-danger/10 text-danger px-4 py-3 text-[9px] font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-35"
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </div>
            )}

            <div className="rounded-2xl bg-olive/5 border border-olive/10 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[9px] font-black uppercase tracking-widest text-olive/60">Layout Health</div>
                  <div className="mt-1 text-sm font-bold text-ink">
                    {visibleRoomEntries.filter(({ room }) => room.mapped_device_mac).length}/{visibleRoomEntries.length} rooms mapped on {floorLabel(selectedFloor)}
                  </div>
                </div>
                <div className="h-10 w-10 rounded-xl bg-white text-olive flex items-center justify-center">
                  <Grid3X3 size={16} />
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-bg-card/30 border border-olive/5 p-4">
              <div className="text-[9px] font-black uppercase tracking-widest text-ink/35 mb-3">Unmapped Devices</div>
              <div className="space-y-2">
                {unmappedDevices.length ? unmappedDevices.map(device => (
                  <div key={device.mac_address} className="flex items-center justify-between gap-3 text-xs font-bold text-ink">
                    <span className="truncate">{device.device_alias}</span>
                    <span className="text-[9px] text-ink/35">{device.device_type}</span>
                  </div>
                )) : (
                  <p className="text-xs text-ink/40">All paired devices are mapped or no devices are registered.</p>
                )}
              </div>
            </div>
          </aside>
        </div>
      ) : (
        <TwinHud rooms={rooms} devices={allDevices} meshId={meshId} selectedFloor={selectedFloor} liveTelemetry={liveTelemetry} />
      )}

      {isLoading && (
        <div className="fixed inset-0 z-30 bg-bg-base/40 backdrop-blur-sm flex items-center justify-center">
          <div className="rounded-3xl bg-white border border-olive/10 px-6 py-4 text-sm font-bold text-olive shadow-xl">
            Loading digital twin...
          </div>
        </div>
      )}
    </motion.div>
  );
};

const TwinHud = ({
  rooms,
  devices,
  meshId,
  selectedFloor,
  liveTelemetry,
}: {
  rooms: RoomLayout[];
  devices: LayoutDevice[];
  meshId: string;
  selectedFloor: number;
  liveTelemetry: any;
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const roomsRef = useRef(rooms);
  const telemetryRef = useRef(liveTelemetry);
  const gatewayOnline = devices.some(device => ['gateway', 'relay'].includes(device.role) && device.is_active);
  const offlineDevices = devices.filter(device => !device.is_active);
  const meshFault = isFaultStatus(liveTelemetry?.status);
  const meshHealthy = devices.length > 0 && gatewayOnline && offlineDevices.length === 0 && !meshFault;
  const meshStatusLabel = meshHealthy
    ? 'Mesh Online'
    : !devices.length
      ? 'No Paired Mesh'
      : meshFault
        ? 'Mesh Alert'
        : !gatewayOnline
          ? 'Gateway Offline'
          : `${offlineDevices.length} Node${offlineDevices.length === 1 ? '' : 's'} Offline`;

  useEffect(() => {
    roomsRef.current = rooms;
    telemetryRef.current = liveTelemetry;
  }, [rooms, liveTelemetry]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xfdfbf7);
    const camera = new THREE.OrthographicCamera(-12, 12, 8, -8, 0.1, 100);
    camera.position.set(8, 10, 10);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    const directional = new THREE.DirectionalLight(0xffffff, 1.4);
    directional.position.set(8, 12, 8);
    scene.add(ambient, directional);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 12),
      new THREE.MeshStandardMaterial({ color: 0xf2e8d5, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.06;
    scene.add(floor);

    const group = new THREE.Group();
    scene.add(group);
    const flowDots: { mesh: THREE.Mesh; speed: number; radius: number; phase: number; x: number; z: number }[] = [];

    const rebuild = () => {
      group.clear();
      flowDots.length = 0;
      const sourceRooms = roomsRef.current.length ? roomsRef.current : starterRooms;
      const layoutRooms = sourceRooms.filter(room => Number(room.floor ?? 0) === selectedFloor);
      const scale = 0.62;
      const offsetX = (GRID_COLS * scale) / 2;
      const offsetZ = (GRID_ROWS * scale) / 2;
      const watts = Number(telemetryRef.current?.current || 0) * 230;
      const status = String(telemetryRef.current?.status || 'SAFE').toUpperCase();

      layoutRooms.forEach((room, index) => {
        const active = room.mapped_device_mac || (room.devices && room.devices.length);
        const color = isFaultStatus(status)
          ? 0xbc4749
          : active
            ? 0x8fa189
            : 0xd4a373;
        const width = room.grid_w * scale;
        const depth = room.grid_h * scale;
        const x = room.grid_x * scale + width / 2 - offsetX;
        const z = room.grid_y * scale + depth / 2 - offsetZ;

        const floorMesh = new THREE.Mesh(
          new THREE.BoxGeometry(width, 0.12, depth),
          new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.02 })
        );
        floorMesh.position.set(x, 0.04, z);
        group.add(floorMesh);

        const wallColor = isFaultStatus(status)
          ? 0xd9a1a2
          : active
            ? 0xf8f7f1
            : 0xefe7d6;
        const roomDoors = normalizeDoors(room);
        const walls = createRoomWalls(width, depth, wallColor, roomDoors);
        walls.position.set(x, 0.12, z);
        group.add(walls);

        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(width, 0.04, depth)),
          new THREE.LineBasicMaterial({ color: 0x3e423a, transparent: true, opacity: 0.16 })
        );
        outline.position.set(x, 0.125, z);
        group.add(outline);

        roomDoors.forEach(doorConfig => {
          const marker = createDoorMarker(width, depth, doorConfig);
          marker.position.x += x;
          marker.position.z += z;
          group.add(marker);
        });

        const label = makeLabel(room.name, active ? roomEspNames(room, devices) : 'No ESP mapped');
        label.position.set(x, 1.08, z);
        group.add(label);

        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.07, 16, 16),
          new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 0.75 })
        );
        group.add(dot);
        flowDots.push({
          mesh: dot,
          speed: 0.35 + Math.min(watts / 1800, 1.8),
          radius: Math.max(width, depth) / 2 + 0.12,
          phase: index * 0.9,
          x,
          z,
        });
      });
    };

    rebuild();

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const t = performance.now() / 1000;
      group.rotation.y = Math.sin(t * 0.18) * 0.035;
      flowDots.forEach(dot => {
        const angle = t * dot.speed + dot.phase;
        dot.mesh.position.x = dot.x + Math.cos(angle) * dot.radius * 0.8;
        dot.mesh.position.z = dot.z + Math.sin(angle) * dot.radius * 0.55;
        dot.mesh.position.y = 0.42 + Math.sin(angle * 2) * 0.04;
      });
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);

    const interval = window.setInterval(rebuild, 2500);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(frame);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [selectedFloor, devices]);

  return (
    <div className="bg-white rounded-[2.5rem] border border-olive/10 shadow-sm overflow-hidden">
      <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4 p-4 sm:p-5 border-b border-olive/5">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-widest text-ink">2.5D Safety HUD</h3>
          <p className="text-xs text-ink/40 mt-1">
            Mesh: <span className="font-black text-ink">{meshId || 'Not configured'}</span>
            <span className="mx-2 text-ink/20">/</span>
            <span className="font-black text-ink">{floorLabel(selectedFloor)}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className={cn(
            'flex items-center gap-2 text-[10px] font-black uppercase tracking-widest rounded-2xl px-3 py-2 border',
            meshHealthy
              ? 'text-olive bg-olive/5 border-olive/10'
              : 'text-danger bg-danger/10 border-danger/20 animate-pulse'
          )}>
            <ShieldAlert size={14} />
            {meshStatusLabel}
          </div>
          <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-olive bg-olive/5 border border-olive/10 rounded-2xl px-3 py-2">
            <Zap size={14} />
            {Number(liveTelemetry?.current || 0).toFixed(2)}A Live
          </div>
          <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-ink/45 bg-bg-card/35 border border-olive/5 rounded-2xl px-3 py-2">
            <Box size={14} />
            {(rooms.length ? rooms : starterRooms).filter(room => Number(room.floor ?? 0) === selectedFloor).length} Rooms
          </div>
        </div>
      </div>
      <div ref={mountRef} className="h-[420px] sm:h-[520px] w-full" />
    </div>
  );
};

const createRoomWalls = (width: number, depth: number, color: number, doors: RoomDoor[]) => {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.01 });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x3e423a, transparent: true, opacity: 0.18 });
  const y = WALL_HEIGHT / 2;

  const addWall = (length: number, horizontal: boolean, center: number, fixed: number) => {
    if (length <= 0.08) return;
    const geometry = horizontal
      ? new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS)
      : new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, length);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(horizontal ? center : fixed, y, horizontal ? fixed : center);
    group.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
    edges.position.copy(mesh.position);
    group.add(edges);
  };

  const buildWall = (wall: DoorWall) => {
    const horizontal = wall === 'top' || wall === 'bottom';
    const length = horizontal ? width : depth;
    const fixed = wall === 'top' ? -depth / 2 : wall === 'bottom' ? depth / 2 : wall === 'left' ? -width / 2 : width / 2;
    const relevantDoors = doors
      .filter(door => door.wall === wall)
      .map(door => {
        const gap = clamp(door.width, 0.12, 0.75) * length;
        const center = (clamp(door.offset, 0.08, 0.92) - 0.5) * length;
        return {
          start: clamp(center - gap / 2, -length / 2, length / 2),
          end: clamp(center + gap / 2, -length / 2, length / 2),
        };
      })
      .sort((a, b) => a.start - b.start);

    let cursor = -length / 2;
    relevantDoors.forEach(gap => {
      const segmentLength = gap.start - cursor;
      addWall(segmentLength, horizontal, cursor + segmentLength / 2, fixed);
      cursor = Math.max(cursor, gap.end);
    });
    const segmentLength = length / 2 - cursor;
    addWall(segmentLength, horizontal, cursor + segmentLength / 2, fixed);
  };

  buildWall('top');
  buildWall('right');
  buildWall('bottom');
  buildWall('left');

  return group;
};

const createDoorMarker = (width: number, depth: number, door: RoomDoor) => {
  const horizontal = door.wall === 'top' || door.wall === 'bottom';
  const wallLength = horizontal ? width : depth;
  const markerLength = clamp(door.width, 0.12, 0.75) * wallLength;
  const marker = new THREE.Mesh(
    horizontal
      ? new THREE.BoxGeometry(markerLength, 0.035, 0.12)
      : new THREE.BoxGeometry(0.12, 0.035, markerLength),
    new THREE.MeshStandardMaterial({ color: 0x606c38, roughness: 0.7 })
  );
  const position = (clamp(door.offset, 0.08, 0.92) - 0.5) * wallLength;
  marker.position.y = 0.15;
  if (door.wall === 'top') {
    marker.position.set(position, 0.15, -depth / 2 - 0.015);
  } else if (door.wall === 'bottom') {
    marker.position.set(position, 0.15, depth / 2 + 0.015);
  } else if (door.wall === 'left') {
    marker.position.set(-width / 2 - 0.015, 0.15, position);
  } else {
    marker.position.set(width / 2 + 0.015, 0.15, position);
  }
  return marker;
};

const makeLabel = (name: string, subtitle: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 320;
  const ctx = canvas.getContext('2d')!;

  ctx.shadowColor = 'rgba(31,36,27,0.20)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.roundRect(32, 28, canvas.width - 64, canvas.height - 56, 34);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(96,108,56,0.26)';
  ctx.stroke();

  ctx.fillStyle = '#3E423A';
  ctx.font = '800 60px Arial';
  ctx.textBaseline = 'top';
  ctx.fillText(name.slice(0, 22), 72, 76);

  ctx.fillStyle = 'rgba(96,108,56,0.92)';
  ctx.font = '800 34px Arial';
  ctx.fillText(subtitle.slice(0, 44), 72, 164);

  if (subtitle.length > 44) {
    ctx.fillStyle = 'rgba(62,66,58,0.58)';
    ctx.font = '700 28px Arial';
    ctx.fillText(subtitle.slice(44, 88), 72, 212);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.35, 0.74, 1);
  return sprite;
};
