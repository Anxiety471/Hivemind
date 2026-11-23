import { Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { SubscriptionGate } from "../../components/billing/SubscriptionGate";
import { PageLoading } from "../../components/PageLoading";
import { lazyComponent } from "../../lib/platform/preload-recovery";

const AuthPage = lazyComponent(() => import("../auth/Auth").then((module) => module.AuthPage));
const PasswordResetPage = lazyComponent(() =>
  import("../auth/Auth").then((module) => module.PasswordResetPage),
);
const FilesPage = lazyComponent(() =>
  import("../space/files/FilesPage").then((module) => module.FilesPage),
);

const FILES = "/app/files";

/**
 * What the Drive app serves: the Files page, signed in with the same session as the main app.
 * Signing in is the main app's own form, so an account made here lands in the same place.
 */
export function DriveRoutes({ signedIn, next }: { signedIn: boolean; next: string | null }) {
  const { pathname } = useLocation();
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to={signedIn ? FILES : "/sign-in"} replace />} />
        {["/sign-in", "/sign-in/email"].map((path) => (
          <Route
            key={path}
            path={path}
            element={
              signedIn ? <Navigate to={next ?? FILES} replace /> : <AuthPage key={path} mode="in" />
            }
          />
        ))}
        {["/sign-up", "/sign-up/email"].map((path) => (
          <Route
            key={path}
            path={path}
            element={
              signedIn ? <Navigate to={next ?? FILES} replace /> : <AuthPage key={path} mode="up" />
            }
          />
        ))}
        <Route
          path="/forgot-password"
          element={
            signedIn ? <Navigate to={FILES} replace /> : <AuthPage key="forgot" mode="forgot" />
          }
        />
        <Route path="/reset-password" element={<PasswordResetPage />} />
        <Route
          element={
            signedIn ? (
              <SubscriptionGate fallback={<PageLoading />}>
                <Outlet />
              </SubscriptionGate>
            ) : (
              <Navigate to={`/sign-in?next=${encodeURIComponent(pathname)}`} replace />
            )
          }
        >
          <Route path={FILES} element={<FilesPage />} />
          <Route path={`${FILES}/folder/:folderId`} element={<FilesPage />} />
          <Route path={`${FILES}/:artifactId`} element={<FilesPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
