import { useLingui } from "@lingui/react/macro";
import type { DriveFolderTreeEntry } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  ChevronsUpDown,
  ExternalLink,
  Folder,
  HardDrive,
  LogOut,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useMatch } from "react-router-dom";
import { authClient } from "../../lib/auth/auth";
import { useSignOut } from "../../lib/auth/sign-out";
import { useQueryUserId, useSpaceQueries } from "../../lib/query/query";
import { switchOrganization, useOrganizations } from "../../lib/spaces/organizations";

export const DRIVE_FILES_PATH = "/app/files";
export const DRIVE_TRASH_PATH = `${DRIVE_FILES_PATH}/trash`;

/** The Drive app's frame: a sidebar with places, folders and the account, around the page. */
export function DriveShell() {
  const { t } = useLingui();
  return (
    <SidebarProvider className="h-full">
      <DriveSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          <SidebarTrigger aria-label={t`Menu`} />
          <span className="font-medium">{t`Drive`}</span>
        </div>
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function DriveSidebar() {
  const { t } = useLingui();
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  // A drawer on phones: following a link closes it.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);
  const trash = pathname === DRIVE_TRASH_PATH;
  return (
    <Sidebar>
      <SidebarHeader className="gap-2 p-3">
        <div className="flex items-center gap-2 px-1 py-0.5">
          <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
            <HardDrive className="size-4" strokeWidth={1.9} aria-hidden="true" />
          </span>
          <span className="font-semibold text-foreground">{t`Drive`}</span>
        </div>
        <SpaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={!trash} render={<Link to={DRIVE_FILES_PATH} />}>
                  <Folder />
                  <span>{t`My files`}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={trash} render={<Link to={DRIVE_TRASH_PATH} />}>
                  <Trash2 />
                  <span>{t`Trash`}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <FolderTree />
      </SidebarContent>
      <SidebarFooter className="p-2">
        <AccountMenu />
      </SidebarFooter>
    </Sidebar>
  );
}

/** Switches between the organizations the person belongs to; absent when there is only one. */
function SpaceSwitcher() {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const { organizations, activeOrganizationId } = useOrganizations();
  if (organizations.length < 2) return null;
  const active = organizations.find((organization) => organization.id === activeOrganizationId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t`Switch space`}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-sidebar-border px-2.5 py-1.5 text-start text-body-sm hover:bg-sidebar-accent"
          />
        }
      >
        <span className="truncate">{active?.name ?? t`Personal`}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {organizations.map((organization) => (
          <DropdownMenuItem
            key={organization.id}
            onClick={() => void switchOrganization(userId, organization)}
          >
            <span className="truncate">{organization.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The folders of the Space as a tree that opens down to the folder being viewed. */
function FolderTree() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const tree = useQuery(queries.files.folderTree.queryOptions());
  const currentId = useMatch(`${DRIVE_FILES_PATH}/folder/:folderId`)?.params.folderId ?? null;
  const { byParent, ancestors } = useMemo(() => {
    const folders = tree.data?.folders ?? [];
    const children = new Map<string | null, DriveFolderTreeEntry[]>();
    for (const folder of folders) {
      const siblings = children.get(folder.parentId) ?? [];
      siblings.push(folder);
      children.set(folder.parentId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((a, b) => a.name.localeCompare(b.name));
    }
    const parents = new Map(folders.map((folder) => [folder.id, folder.parentId]));
    // The folder being viewed opens too, so what is inside it shows beside the list.
    const open = new Set<string>(currentId ? [currentId] : []);
    for (let id = currentId; id; ) {
      const parent = parents.get(id) ?? null;
      if (parent) open.add(parent);
      id = parent;
    }
    return { byParent: children, ancestors: open };
  }, [tree.data, currentId]);
  const roots = byParent.get(null) ?? [];
  if (roots.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t`Folders`}</SidebarGroupLabel>
      <SidebarGroupContent>
        <ul className="flex flex-col gap-0.5">
          {roots.map((folder) => (
            <FolderNode
              key={folder.id}
              folder={folder}
              depth={0}
              byParent={byParent}
              ancestors={ancestors}
              currentId={currentId}
            />
          ))}
        </ul>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function FolderNode({
  folder,
  depth,
  byParent,
  ancestors,
  currentId,
}: {
  folder: DriveFolderTreeEntry;
  depth: number;
  byParent: Map<string | null, DriveFolderTreeEntry[]>;
  ancestors: Set<string>;
  currentId: string | null;
}) {
  const { t } = useLingui();
  const children = byParent.get(folder.id) ?? [];
  const onPath = ancestors.has(folder.id);
  const [open, setOpen] = useState(onPath);
  // Opening a deeper folder elsewhere on the page opens the way down to it here.
  useEffect(() => {
    if (onPath) setOpen(true);
  }, [onPath]);
  const active = currentId === folder.id;
  return (
    <li>
      <div
        className={`flex items-center rounded-md text-body-sm ${
          active
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/60"
        }`}
        style={{ paddingInlineStart: `${depth * 0.75}rem` }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            aria-label={open ? t`Collapse ${folder.name}` : t`Expand ${folder.name}`}
            aria-expanded={open}
            className="grid size-6 shrink-0 place-items-center text-muted-foreground"
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronRight
              className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className="size-6 shrink-0" aria-hidden="true" />
        )}
        <Link
          to={`${DRIVE_FILES_PATH}/folder/${encodeURIComponent(folder.id)}`}
          aria-current={active ? "page" : undefined}
          className="min-w-0 flex-1 truncate py-1.5 pe-2"
        >
          {folder.name}
        </Link>
      </div>
      {open && children.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {children.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              depth={depth + 1}
              byParent={byParent}
              ancestors={ancestors}
              currentId={currentId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Who is signed in, with the way back to the main app and signing out. */
function AccountMenu(): ReactNode {
  const { t } = useLingui();
  const session = authClient.useSession();
  const me = useQuery(useSpaceQueries().me.queryOptions()).data;
  const [error, setError] = useState<string | null>(null);
  const { logOut, signingOut } = useSignOut("/sign-in", setError);
  const user = session.data?.user;
  if (!user) return null;
  const account = accountDisplay(user, t`Account`);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
            <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground uppercase">
              {account.image ? (
                <img src={account.image} alt="" className="size-full object-cover" />
              ) : (
                (account.initial ?? "?")
              )}
            </span>
            <span className="min-w-0 flex-1 text-start leading-tight">
              <span className="block truncate font-medium">{account.label}</span>
              {user.email && user.email !== account.label ? (
                <span className="block truncate text-label text-muted-foreground">
                  {user.email}
                </span>
              ) : null}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            {me?.appUrl ? (
              <DropdownMenuItem render={<a href={me.appUrl} />}>
                <ExternalLink />
                {t`Open Rakazo`}
              </DropdownMenuItem>
            ) : null}
            {me?.appUrl ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem disabled={signingOut} onClick={() => void logOut()}>
              <LogOut />
              {t`Log out`}
            </DropdownMenuItem>
            {error ? (
              <DropdownMenuLabel role="alert" className="text-destructive">
                {error}
              </DropdownMenuLabel>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
