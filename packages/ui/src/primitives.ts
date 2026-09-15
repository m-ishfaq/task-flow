/**
 * Radix primitive re-exports, separated from the styled component files
 * so react-refresh/only-export-components does not fire on the component files.
 *
 * Each styled file (dropdown-menu.tsx, modal.tsx, popover.tsx) defines custom
 * components, and this file re-exports the underlying Radix primitives they
 * wrap. `index.ts` re-exports everything from both.
 */
export {
  Root as DropdownMenuRoot,
  Trigger as DropdownMenuTrigger,
} from '@radix-ui/react-dropdown-menu';
export {
  Root as ModalRoot,
  Trigger as ModalTrigger,
  Close as ModalClose,
} from '@radix-ui/react-dialog';
export {
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
  Close as PopoverClose,
} from '@radix-ui/react-popover';
export {
  Root as TooltipRoot,
  Trigger as TooltipTrigger,
  Provider as TooltipProvider,
} from '@radix-ui/react-tooltip';
