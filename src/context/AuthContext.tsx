/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { AppUser, UserRole, AuthorizationStatus } from "../types";
import { DEMO_USERS } from "../data/initialData";
import { useToast } from "./ToastContext";
import {
  getSafeFirebase,
  getUserDocFromFirestore,
  subscribeToUserDoc,
  registerAccessRequestToFirestore,
} from "../services/firebaseAuthService";
import {
  isRoleSuperAdmin,
  isRoleAdmin,
  isRoleEmployee,
  normalizeUserRole,
  checkIsUserSuperAdmin,
  isApprovedStatus,
  isPendingStatus,
  isRejectedStatus,
  SUPER_ADMIN_EMAILS,
} from "../lib/authUtils";
import { onAuthStateChanged, signOut as fbSignOut } from "firebase/auth";
import { doc, setDoc, serverTimestamp, collection, query, where, getDocs, getDoc } from "firebase/firestore";

interface AuthContextType {
  currentUser: AppUser | null;
  currentRole: UserRole;
  isAuthenticated: boolean;
  isApproved: boolean;
  isPending: boolean;
  isRejected: boolean;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isEmployee: boolean;
  isLoading: boolean;
  demoUsers: AppUser[];
  loginWithGoogle: (email: string, name?: string) => Promise<{
    success: boolean;
    case: "A" | "B" | "C" | "D";
    status: AuthorizationStatus;
    message: string;
    user?: AppUser;
  }>;
  login: (email: string, pass?: string) => Promise<{ success: boolean; user?: AppUser; error?: string }>;
  logout: () => void;
  switchDemoUser: (target: string) => AppUser | null;
  switchPersona: (employeeIdOrUid: string) => AppUser | null;
  setCurrentUser: React.Dispatch<React.SetStateAction<AppUser | null>>;
  hasPermission: (allowedRoles: (UserRole | string)[]) => boolean;
  refreshUserStatus: () => Promise<AuthorizationStatus | null>;
  isSignInModalOpen: boolean;
  setIsSignInModalOpen: (open: boolean) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_STORAGE_KEY = "modela_active_user_data";
export const SESSION_REQUEST_KEY = "modela_session_request_submitted";

// Safe non-blocking navigation to Admin Nexus
const navigateToAdminNexus = () => {
  if (typeof window !== "undefined" && window.location.pathname !== "/admin-nexus") {
    try {
      window.history.pushState({}, "", "/admin-nexus");
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
      window.location.pathname = "/admin-nexus";
    }
  }
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { toast, success, info, error: toastError } = useToast();

  // Reset local storage state on initial load so the application always opens to Step 1
  // unless a request has actually been submitted during the session.
  const [currentUser, setCurrentUser] = useState<AppUser | null>(() => {
    try {
      const hasSessionRequest = sessionStorage.getItem(SESSION_REQUEST_KEY);
      if (!hasSessionRequest) {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        localStorage.removeItem("modela_jwt_token");
        return null;
      }
      const saved = localStorage.getItem(AUTH_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.email) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return null;
  });

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const setLoading = setIsLoading;
  const [isSignInModalOpen, setIsSignInModalOpen] = useState<boolean>(false);

  // Sync current user to local storage (no images stored)
  useEffect(() => {
    if (currentUser) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(currentUser));
    } else {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  }, [currentUser]);

  // Safe Firebase Auth listener with Direct Super Admin Bypass and 3s Fallback Timeout
  useEffect(() => {
    let isMounted = true;
    let fallbackTimer: NodeJS.Timeout | null = null;

    // 1. Fallback timeout (3 seconds): If Firestore takes longer than 3 seconds to verify clearance,
    // resolve the loading state immediately so the app never hangs on the loading spinner.
    fallbackTimer = setTimeout(() => {
      if (isMounted) {
        console.warn("[Auth] Security clearance timeout (3000ms). Forcing loading state resolution.");
        setLoading(false);
      }
    }, 3000);

    const { auth, db } = getSafeFirebase();

    if (!auth) {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!isMounted) return;

      const userEmail = user?.email?.trim().toLowerCase() || "";

      // 2. Direct Super Admin Bypass:
      // When onAuthStateChanged fires, check if user.email === 'modelatech2026@gmail.com'.
      // If true, instantly assign role: 'SUPER_ADMIN', set loading: false, and navigate to /admin-nexus immediately
      // without waiting on hanging database calls.
      const isSuperAdminBypass =
        userEmail === "modelatech2026@gmail.com" ||
        SUPER_ADMIN_EMAILS.some((adm) => adm.toLowerCase() === userEmail);

      if (user && isSuperAdminBypass) {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }

        const superAdminUser: AppUser = {
          uid: user.uid || "USR-SUPERADMIN-01",
          name: user.displayName || "Super Admin",
          email: "modelatech2026@gmail.com",
          role: "SUPER_ADMIN",
          status: "Approved",
          isSuperAdmin: true,
          employeeId: "MOD000",
        };

        setCurrentUser(superAdminUser);
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(superAdminUser));
        localStorage.setItem("modela_jwt_token", "modela_session_superadmin_" + Date.now());
        sessionStorage.setItem(SESSION_REQUEST_KEY, "modelatech2026@gmail.com");

        setLoading(false);

        // Instantly navigate to /admin-nexus without waiting on hanging database calls
        navigateToAdminNexus();

        // Non-blocking fire-and-forget background sync
        if (db) {
          setDoc(
            doc(db, "users", superAdminUser.uid),
            {
              uid: superAdminUser.uid,
              displayName: superAdminUser.name,
              name: superAdminUser.name,
              email: "modelatech2026@gmail.com",
              status: "Approved",
              role: "SUPER_ADMIN",
              isSuperAdmin: true,
              reviewedAt: serverTimestamp(),
              reviewedBy: "System Root",
            },
            { merge: true }
          ).catch((e) => console.warn("Background Super Admin users sync note:", e));

          setDoc(
            doc(db, "access_requests", superAdminUser.uid),
            {
              uid: superAdminUser.uid,
              displayName: superAdminUser.name,
              name: superAdminUser.name,
              email: "modelatech2026@gmail.com",
              photoURL: "",
              status: "APPROVED",
              requestedAt: serverTimestamp(),
              role: "SUPER_ADMIN",
            },
            { merge: true }
          ).catch((e) => console.warn("Background Super Admin access_requests sync note:", e));
        }

        return;
      }

      // If user is not authenticated with Firebase Auth
      if (!user) {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        const stored = localStorage.getItem(AUTH_STORAGE_KEY);
        if (!stored) {
          setCurrentUser(null);
        }
        setLoading(false);
        return;
      }

      // 1. Safe Auth State Resolution:
      // Wrap the Firestore clearance check inside a strict try/catch/finally block.
      // Ensure setLoading(false) is ALWAYS called in the finally block.
      try {
        let resolvedUser: AppUser | null = null;
        const cleanName = user.displayName || userEmail.split("@")[0];

        if (db) {
          // Race clearance check against a 3-second timeout
          const clearancePromise = async (): Promise<AppUser | null> => {
            try {
              const userRef = doc(db, "users", user.uid);
              const userSnap = await getDoc(userRef);
              if (userSnap.exists()) {
                const data = userSnap.data();
                return {
                  uid: user.uid,
                  name: data.displayName || data.name || cleanName,
                  email: userEmail,
                  role: (data.role as UserRole) || null,
                  status: (data.status as AuthorizationStatus) || "Pending",
                  employeeId: data.employeeId,
                  designation: data.designation,
                  isSuperAdmin: checkIsUserSuperAdmin(data),
                };
              }

              const reqRef = doc(db, "access_requests", user.uid);
              const reqSnap = await getDoc(reqRef);
              if (reqSnap.exists()) {
                const reqData = reqSnap.data();
                return {
                  uid: user.uid,
                  name: reqData.displayName || reqData.name || cleanName,
                  email: userEmail,
                  role: (reqData.role as UserRole) || null,
                  status:
                    reqData.status === "APPROVED"
                      ? "Approved"
                      : reqData.status === "REJECTED"
                      ? "Rejected"
                      : "Pending",
                  isSuperAdmin: false,
                };
              }
            } catch (fetchErr) {
              console.warn("Firestore clearance document retrieval warning:", fetchErr);
            }
            return null;
          };

          const timeoutPromise = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 3000)
          );

          resolvedUser = await Promise.race([clearancePromise(), timeoutPromise]);
        }

        if (isMounted) {
          if (resolvedUser) {
            setCurrentUser(resolvedUser);
          } else {
            setCurrentUser((prev) => {
              if (prev && prev.email.toLowerCase() === userEmail) {
                return prev;
              }
              return {
                uid: user.uid,
                name: cleanName,
                email: userEmail,
                role: "PENDING",
                status: "Pending",
                isSuperAdmin: false,
              };
            });
          }
        }
      } catch (err) {
        console.warn("Security clearance verification error caught safely:", err);
      } finally {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        if (isMounted) {
          // ALWAYS called in the finally block
          setLoading(false);
        }
      }
    });

    return () => {
      isMounted = false;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      unsubscribe();
    };
  }, []);

  // Google OAuth Login Action
  const loginWithGoogle = useCallback(
    async (
      email: string,
      name?: string
    ): Promise<{
      success: boolean;
      case: "A" | "B" | "C" | "D";
      status: AuthorizationStatus;
      message: string;
      user?: AppUser;
    }> => {
      setLoading(true);
      const cleanEmail = email.trim().toLowerCase();
      const cleanName =
        name?.trim() ||
        cleanEmail.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

      // 1. SUPER ADMIN PERMANENT VERIFICATION & DIRECT BYPASS
      const isSuperAdminMatch =
        cleanEmail === "modelatech2026@gmail.com" ||
        SUPER_ADMIN_EMAILS.some((adminEmail) => adminEmail.toLowerCase() === cleanEmail);

      if (isSuperAdminMatch) {
        const superAdminUser: AppUser = {
          uid: "USR-SUPERADMIN-01",
          name: cleanName || "Super Admin",
          email: "modelatech2026@gmail.com",
          role: "SUPER_ADMIN",
          status: "Approved",
          isSuperAdmin: true,
          employeeId: "MOD000",
        };

        setCurrentUser(superAdminUser);
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(superAdminUser));
        localStorage.setItem("modela_jwt_token", "modela_session_superadmin_" + Date.now());
        sessionStorage.setItem(SESSION_REQUEST_KEY, "modelatech2026@gmail.com");

        setLoading(false);

        // Direct navigation to /admin-nexus immediately without waiting on hanging database calls
        navigateToAdminNexus();

        // Non-blocking fire-and-forget background sync
        const { db } = getSafeFirebase();
        if (db) {
          setDoc(
            doc(db, "users", superAdminUser.uid),
            {
              uid: superAdminUser.uid,
              displayName: superAdminUser.name,
              name: superAdminUser.name,
              email: "modelatech2026@gmail.com",
              status: "Approved",
              role: "SUPER_ADMIN",
              isSuperAdmin: true,
              reviewedAt: serverTimestamp(),
              reviewedBy: "System Root",
            },
            { merge: true }
          ).catch((e) => console.warn("Firestore Super Admin record sync warning:", e));

          setDoc(
            doc(db, "access_requests", superAdminUser.uid),
            {
              uid: superAdminUser.uid,
              displayName: superAdminUser.name,
              name: superAdminUser.name,
              email: "modelatech2026@gmail.com",
              photoURL: "",
              status: "APPROVED",
              requestedAt: serverTimestamp(),
              role: "SUPER_ADMIN",
            },
            { merge: true }
          ).catch((e) => console.warn("Firestore Super Admin access request sync warning:", e));
        }

        // Notify client-side mock transparently
        fetch("/api/auth/google", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: cleanEmail, name: cleanName }),
        }).catch(() => {});

        success(
          "Super Admin Clearance Granted",
          `Welcome Architect ${superAdminUser.name}. Operational clearance unlocked.`
        );

        return {
          success: true,
          case: "D",
          status: "Approved",
          message: "Super Admin authorized.",
          user: superAdminUser,
        };
      }

      // 2. STANDARD / NEW USER AUTHORIZATION & GLOBAL FIRESTORE REGISTRATION
      try {
        const { db } = getSafeFirebase();
        let userUid = "USR-GOOGLE-" + Math.random().toString(36).substring(2, 9).toUpperCase();
        let currentStatus: AuthorizationStatus = "Pending";
        let currentRole: UserRole | string | null = "PENDING";

        // Check if user already exists in global Firestore with 3s timeout
        if (db) {
          try {
            const firestoreCheck = async () => {
              const q = query(collection(db, "access_requests"), where("email", "==", cleanEmail));
              const snap = await getDocs(q);
              if (!snap.empty) {
                const existingDoc = snap.docs[0];
                const existingData = existingDoc.data();
                userUid = existingData.uid || existingDoc.id;
                currentStatus =
                  existingData.status === "APPROVED"
                    ? "Approved"
                    : existingData.status === "REJECTED"
                    ? "Rejected"
                    : "Pending";
                currentRole = existingData.role || "PENDING";
              } else {
                const reqRef = doc(db, "access_requests", userUid);
                await setDoc(
                  reqRef,
                  {
                    uid: userUid,
                    displayName: cleanName,
                    name: cleanName,
                    email: cleanEmail,
                    photoURL: "",
                    status: "PENDING",
                    requestedAt: serverTimestamp(),
                    role: "PENDING",
                  },
                  { merge: true }
                );

                const userRef = doc(db, "users", userUid);
                await setDoc(
                  userRef,
                  {
                    uid: userUid,
                    displayName: cleanName,
                    name: cleanName,
                    email: cleanEmail,
                    photoURL: "",
                    status: "PENDING",
                    requestedAt: serverTimestamp(),
                    role: "PENDING",
                  },
                  { merge: true }
                );
              }
            };

            await Promise.race([
              firestoreCheck(),
              new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
          } catch (err) {
            console.warn("Firestore access_requests global write failed:", err);
          }
        }

        // Advance UI to Pending Queue state in session storage (bypassing localStorage authorization cache)
        sessionStorage.setItem(SESSION_REQUEST_KEY, cleanEmail);

        // Execute API synchronization
        try {
          const res = await fetch("/api/auth/google", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: cleanEmail, name: cleanName, uid: userUid }),
          });

          const data = await res.json();
          const serverUser = data.user;

          if (data.token) {
            localStorage.setItem("modela_jwt_token", data.token);
          }

          if (serverUser?.status) {
            currentStatus =
              serverUser.status === "APPROVED" || serverUser.status === "Approved"
                ? "Approved"
                : serverUser.status === "REJECTED" || serverUser.status === "Rejected"
                ? "Rejected"
                : "Pending";
          }
          if (serverUser?.role) {
            currentRole = serverUser.role;
          }
          if (serverUser?.uid) {
            userUid = serverUser.uid;
          }
        } catch {
          // Transparent fallback
        }

        const resolvedUser: AppUser = {
          uid: userUid,
          name: cleanName,
          email: cleanEmail,
          status: currentStatus,
          role: currentRole || "PENDING",
          isSuperAdmin: false,
        };

        setCurrentUser(resolvedUser);

        if (currentStatus === "Approved") {
          success(
            "Access Authorized",
            `Welcome back, ${resolvedUser.name}. Authenticated as ${resolvedUser.role || "Staff Member"}.`
          );
        } else if (currentStatus === "Rejected") {
          toastError("Access Denied", "Your request for access has been rejected.");
        } else {
          info(
            "Access Request Submitted",
            "Your access request has been registered in the live Firestore backend. Please wait for Super Admin approval."
          );
        }

        return {
          success: currentStatus === "Approved",
          case: currentStatus === "Approved" ? "D" : currentStatus === "Rejected" ? "C" : "A",
          status: currentStatus,
          message:
            currentStatus === "Approved"
              ? "Access approved."
              : currentStatus === "Rejected"
              ? "Access rejected."
              : "Your request has been sent to the Super Admin. Please wait for approval.",
          user: resolvedUser,
        };
      } catch (err: any) {
        const errorMsg = err?.message || "Failed to authenticate with Google.";
        toastError("Sign In Error", errorMsg);
        return {
          success: false,
          case: "A",
          status: "Pending",
          message: errorMsg,
        };
      } finally {
        // ALWAYS called in finally block
        setLoading(false);
      }
    },
    [success, info, toastError]
  );

  // Classic login helper for modals/demo switching
  const login = useCallback(
    async (
      email: string,
      _pass?: string
    ): Promise<{ success: boolean; user?: AppUser; error?: string }> => {
      const res = await loginWithGoogle(email);
      return {
        success: res.status === "Approved",
        user: res.user,
        error: res.status !== "Approved" ? res.message : undefined,
      };
    },
    [loginWithGoogle]
  );

  // Switch demo persona
  const switchDemoUser = useCallback(
    (identifier: string): AppUser | null => {
      const cleanId = identifier.trim().toLowerCase();
      const target =
        DEMO_USERS.find((u) => u.employeeId?.toLowerCase() === cleanId) ||
        DEMO_USERS.find((u) => u.uid?.toLowerCase() === cleanId) ||
        DEMO_USERS.find((u) => u.email.toLowerCase() === cleanId) ||
        DEMO_USERS.find((u) => u.name.toLowerCase() === cleanId) ||
        DEMO_USERS.find((u) => u.name.toLowerCase().includes(cleanId));

      if (target) {
        setCurrentUser(target);
        info("Active Persona", `${target.name} (${target.role})`);
        return target;
      }
      return null;
    },
    [info]
  );

  const switchPersona = useCallback(
    (employeeIdOrUid: string): AppUser | null => {
      return switchDemoUser(employeeIdOrUid);
    },
    [switchDemoUser]
  );

  // Refresh user status from server
  const refreshUserStatus = useCallback(async (): Promise<AuthorizationStatus | null> => {
    if (!currentUser?.email) return null;
    try {
      const res = await fetch(`/api/auth/status?email=${encodeURIComponent(currentUser.email)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.token) {
          localStorage.setItem("modela_jwt_token", data.token);
        }
        if (data.user) {
          const updated: AppUser = {
            ...currentUser,
            status: data.user.status,
            role: data.user.role,
            isSuperAdmin: checkIsUserSuperAdmin(data.user),
          };
          setCurrentUser(updated);
          return data.user.status;
        }
      }
    } catch (err) {
      console.warn("Error refreshing user status:", err);
    }
    return currentUser.status || null;
  }, [currentUser]);

  // Logout with server audit log
  const logout = useCallback(() => {
    const userEmail = currentUser?.email;
    if (userEmail) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: userEmail }),
      }).catch(() => {});
    }

    const { auth } = getSafeFirebase();
    if (auth) {
      fbSignOut(auth).catch(() => {});
    }

    setCurrentUser(null);
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem("modela_jwt_token");
    sessionStorage.removeItem(SESSION_REQUEST_KEY);
    toast({
      type: "info",
      title: "Signed Out",
      description: "You have securely signed out of Modela Connect.",
    });
  }, [currentUser?.email, toast]);

  // Derived authorization flags
  const isSuperAdmin = checkIsUserSuperAdmin(currentUser);
  const currentRole: UserRole = isSuperAdmin
    ? "Super Admin"
    : currentUser?.role
    ? normalizeUserRole(currentUser.role)
    : "Employee";

  const isAdmin = isSuperAdmin || isRoleAdmin(currentUser?.role);
  const isEmployee = !isSuperAdmin && !isAdmin && (isRoleEmployee(currentUser?.role) || currentRole === "Employee");

  const isApproved =
    Boolean(currentUser) &&
    isApprovedStatus(currentUser?.status) &&
    currentUser?.role !== null &&
    currentUser?.role !== "Guest";

  const isPending = Boolean(currentUser) && isPendingStatus(currentUser?.status);
  const isRejected = Boolean(currentUser) && isRejectedStatus(currentUser?.status);

  const hasPermission = useCallback(
    (allowedRoles: (UserRole | string)[]): boolean => {
      if (!currentUser || !isApproved) return false;
      if (isSuperAdmin) return true;
      return allowedRoles.some((r) => {
        const norm = String(r).trim().toUpperCase();
        if (norm === "SUPERADMIN" || norm === "SUPER ADMIN") return isSuperAdmin;
        if (norm === "ADMIN" || norm === "HR ADMIN") return isAdmin;
        if (norm === "EMPLOYEE") return isEmployee;
        return norm === String(currentUser.role).trim().toUpperCase() || norm === currentRole.toUpperCase();
      });
    },
    [currentUser, isApproved, isSuperAdmin, isAdmin, isEmployee, currentRole]
  );

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        currentRole,
        isAuthenticated: !!currentUser,
        isApproved,
        isPending,
        isRejected,
        isSuperAdmin,
        isAdmin,
        isEmployee,
        isLoading,
        demoUsers: DEMO_USERS,
        loginWithGoogle,
        login,
        logout,
        switchDemoUser,
        switchPersona,
        setCurrentUser,
        hasPermission,
        refreshUserStatus,
        isSignInModalOpen,
        setIsSignInModalOpen,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
