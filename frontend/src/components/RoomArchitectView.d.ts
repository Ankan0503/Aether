// Type shim for the ported .jsx component. allowJs is on, but TypeScript still
// wants a declaration to import it from App.tsx without an implicit-any error.

export interface RoomArchitectViewProps {
  zones?: Array<{ id: string; name?: string; active?: boolean }>;
  onToggleZone?: (zoneId: string) => void;
  addToast?: (message: string, icon: unknown) => void;
}

declare const RoomArchitectView: (props: RoomArchitectViewProps) => JSX.Element;
export default RoomArchitectView;
