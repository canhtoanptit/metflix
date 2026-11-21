import { Link } from "@tanstack/react-router";
import { BrandMark } from "@webflix/ui";
import { useBrowseProfile } from "../common/session.ts";

/** Quiet footer: the places people look for at the bottom of a page, and the small print. */
export function Footer() {
  const profile = useBrowseProfile();
  const links = profile.isKids
    ? ([
        { to: "/my-list", label: "My List" },
        { to: "/profiles", label: "Switch profile" },
      ] as const)
    : ([
        { to: "/my-list", label: "My List" },
        { to: "/account", label: "Account" },
        { to: "/profiles/manage", label: "Manage profiles" },
        { to: "/account/activity", label: "Viewing activity" },
        { to: "/account/devices", label: "Devices" },
        { to: "/profiles", label: "Switch profile" },
      ] as const);
  return (
    <footer className="w-full px-gutter pt-20 pb-12">
      <nav aria-label="Footer">
        <ul className="grid max-w-page grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          {links.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                className="focus-ring rounded-sm type-body-sm text-fg-subtle transition-colors duration-fast ease-standard hover:text-fg"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="mt-10 flex items-center gap-2 type-caption text-fg-subtle">
        <BrandMark className="size-4" />
        <span>
          © {new Date().getFullYear()} Webflix. Films and artwork are freely licensed or generated
          for this project.
        </span>
      </p>
    </footer>
  );
}
