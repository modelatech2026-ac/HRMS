/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getApps, initializeApp, FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  Auth,
  User as FirebaseUser,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  onSnapshot,
  Firestore,
  serverTimestamp,
  query,
  where,
} from "firebase/firestore";
import { AuthRequestUser, UserRole, AuthorizationStatus, AppUser } from "../types";

/**
 * Standardized Firestore error handler adhering to platform guidelines
 */
export function handleFirestoreError(error: unknown, operationType: string, path: string): never {
  const errObj = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
  };
  throw new Error(JSON.stringify(errObj));
}

/**
 * Safely resolves Firebase Auth and Firestore if environment credentials exist
 */
export function getSafeFirebase(): { app: FirebaseApp | null; auth: Auth | null; db: Firestore | null } {
  try {
    const apps = getApps();
    if (apps.length > 0) {
      const app = apps[0];
      return {
        app,
        auth: getAuth(app),
        db: getFirestore(app),
      };
    }

    const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> })?.env || {};
    const winConfig = typeof window !== "undefined" ? ((window as any).__FIREBASE_CONFIG__ || (window as any).FIREBASE_CONFIG) : null;

    const projectId = metaEnv.VITE_FIREBASE_PROJECT_ID || winConfig?.projectId || "modela-connect-hr";
    const apiKey = metaEnv.VITE_FIREBASE_API_KEY || winConfig?.apiKey || "AIzaSyModelaConnectLivePublicAppKey";
    const authDomain = metaEnv.VITE_FIREBASE_AUTH_DOMAIN || winConfig?.authDomain || `${projectId}.firebaseapp.com`;
    const storageBucket = metaEnv.VITE_FIREBASE_STORAGE_BUCKET || winConfig?.storageBucket || `${projectId}.appspot.com`;
    const messagingSenderId = metaEnv.VITE_FIREBASE_MESSAGING_SENDER_ID || winConfig?.messagingSenderId || "931937056057";
    const appId = metaEnv.VITE_FIREBASE_APP_ID || winConfig?.appId || "1:931937056057:web:modelaconnect";

    const app = initializeApp({
      apiKey,
      authDomain,
      projectId,
      storageBucket,
      messagingSenderId,
      appId,
    });
    return {
      app,
      auth: getAuth(app),
      db: getFirestore(app),
    };
  } catch (err) {
    console.warn("Firebase Auth/Firestore initialization note:", err);
    const existing = getApps();
    if (existing.length > 0) {
      return {
        app: existing[0],
        auth: getAuth(existing[0]),
        db: getFirestore(existing[0]),
      };
    }
    return { app: null, auth: null, db: null };
  }
}

/**
 * Registers a new access request globally into Firestore 'access_requests' and 'users' collections.
 * Schema: { uid, displayName, name, email, photoURL, status: "PENDING", requestedAt: serverTimestamp(), role: "PENDING" }
 */
export async function registerAccessRequestToFirestore(requestData: {
  uid: string;
  displayName?: string;
  name?: string;
  email: string;
  photoURL?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { db } = getSafeFirebase();
  if (!db) {
    return { success: false, error: "Firestore not initialized" };
  }

  try {
    const displayName = requestData.displayName || requestData.name || requestData.email.split("@")[0];
    const reqRef = doc(db, "access_requests", requestData.uid);
    await setDoc(
      reqRef,
      {
        uid: requestData.uid,
        displayName,
        name: displayName,
        email: requestData.email.trim().toLowerCase(),
        photoURL: requestData.photoURL || "",
        status: "PENDING",
        requestedAt: serverTimestamp(),
        role: "PENDING",
      },
      { merge: true }
    );

    // Also mirror into users collection for unified RBAC querying
    const userRef = doc(db, "users", requestData.uid);
    await setDoc(
      userRef,
      {
        uid: requestData.uid,
        displayName,
        name: displayName,
        email: requestData.email.trim().toLowerCase(),
        photoURL: requestData.photoURL || "",
        status: "PENDING",
        requestedAt: serverTimestamp(),
        role: "PENDING",
      },
      { merge: true }
    );

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("Failed to register access request in Firestore:", msg);
    return { success: false, error: msg };
  }
}

/**
 * Subscribes to real-time changes on the Firestore 'access_requests' collection.
 * Delivers all authorization requests dynamically to Admin Nexus.
 */
export function subscribeToAccessRequests(
  onUpdate: (requests: AuthRequestUser[]) => void
): () => void {
  const { db } = getSafeFirebase();
  if (!db) return () => {};

  try {
    const collRef = collection(db, "access_requests");
    return onSnapshot(
      collRef,
      (snapshot) => {
        const items: AuthRequestUser[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          let reqAt = new Date().toISOString();
          if (data.requestedAt?.toDate) {
            reqAt = data.requestedAt.toDate().toISOString();
          } else if (typeof data.requestedAt === "string") {
            reqAt = data.requestedAt;
          }

          let revAt: string | undefined = undefined;
          if (data.reviewedAt?.toDate) {
            revAt = data.reviewedAt.toDate().toISOString();
          } else if (typeof data.reviewedAt === "string") {
            revAt = data.reviewedAt;
          }

          items.push({
            id: docSnap.id,
            uid: data.uid || docSnap.id,
            name: data.name || (data.email ? data.email.split("@")[0] : "Authorized User"),
            email: data.email || "",
            status: (data.status === "PENDING" ? "PENDING_APPROVAL" : data.status) as AuthorizationStatus,
            role: data.role || (data.status === "APPROVED" ? "EMPLOYEE" : null),
            requestedAt: reqAt,
            reviewedAt: revAt,
            reviewedBy: data.reviewedBy,
          });
        });
        onUpdate(items);
      },
      (error) => {
        console.warn("Real-time access_requests listener error:", error);
      }
    );
  } catch (err) {
    console.warn("Failed to initialize access_requests onSnapshot listener:", err);
    return () => {};
  }
}

/**
 * Updates an access request document in Firestore on Super Admin approval.
 * Updates status to 'APPROVED' and role to 'EMPLOYEE' (or selected clearance role).
 */
export async function acceptAccessRequestInFirestore(
  uid: string,
  role: string = "EMPLOYEE",
  reviewedBy: string = "Super Admin"
): Promise<{ success: boolean; error?: string }> {
  const { db } = getSafeFirebase();
  if (!db) return { success: false, error: "Firestore not initialized" };

  try {
    const reqRef = doc(db, "access_requests", uid);
    await updateDoc(reqRef, {
      status: "APPROVED",
      role,
      reviewedAt: serverTimestamp(),
      reviewedBy,
    });

    const userRef = doc(db, "users", uid);
    await setDoc(
      userRef,
      {
        uid,
        status: "APPROVED",
        role,
        reviewedAt: serverTimestamp(),
        reviewedBy,
      },
      { merge: true }
    );

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("Failed to approve access request in Firestore:", msg);
    return { success: false, error: msg };
  }
}

/**
 * Updates an access request document in Firestore on Super Admin rejection.
 * Updates status to 'REJECTED'.
 */
export async function rejectAccessRequestInFirestore(
  uid: string,
  reviewedBy: string = "Super Admin"
): Promise<{ success: boolean; error?: string }> {
  const { db } = getSafeFirebase();
  if (!db) return { success: false, error: "Firestore not initialized" };

  try {
    const reqRef = doc(db, "access_requests", uid);
    await updateDoc(reqRef, {
      status: "REJECTED",
      reviewedAt: serverTimestamp(),
      reviewedBy,
    });

    const userRef = doc(db, "users", uid);
    await setDoc(
      userRef,
      {
        uid,
        status: "REJECTED",
        reviewedAt: serverTimestamp(),
        reviewedBy,
      },
      { merge: true }
    );

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("Failed to reject access request in Firestore:", msg);
    return { success: false, error: msg };
  }
}

/**
 * Fetches a user document from the Firestore 'users' collection
 */
export async function getUserDocFromFirestore(uid: string): Promise<AppUser | null> {
  const { db } = getSafeFirebase();
  if (!db) return null;

  try {
    const userDocRef = doc(db, "users", uid);
    const snap = await getDoc(userDocRef);
    if (!snap.exists()) return null;

    const data = snap.data();
    return {
      uid: data.uid || uid,
      name: data.name || "Authenticated User",
      email: data.email || "",
      role: (data.role as UserRole) || null,
      status: (data.status as AuthorizationStatus) || "Pending",
      employeeId: data.employeeId || undefined,
      designation: data.designation || undefined,
    };
  } catch (err) {
    console.warn("Error fetching user document from Firestore:", err);
    return null;
  }
}

/**
 * Subscribes to real-time changes on a user document in Firestore 'users/{uid}'
 */
export function subscribeToUserDoc(
  uid: string,
  onUpdate: (user: AppUser | null) => void
): () => void {
  const { db } = getSafeFirebase();
  if (!db) return () => {};

  const userDocRef = doc(db, "users", uid);
  return onSnapshot(
    userDocRef,
    (snap) => {
      if (!snap.exists()) {
        onUpdate(null);
        return;
      }
      const data = snap.data();
      onUpdate({
        uid: data.uid || uid,
        name: data.name || "Authenticated User",
        email: data.email || "",
        role: (data.role as UserRole) || null,
        status: (data.status as AuthorizationStatus) || "Pending",
        employeeId: data.employeeId || undefined,
        designation: data.designation || undefined,
      });
    },
    (err) => {
      console.warn("User doc listener error:", err);
    }
  );
}

/**
 * Syncs a user document into Firestore 'users' collection with NO avatar/photos
 */
export async function syncGoogleUserToFirestore(
  requestUser: AuthRequestUser
): Promise<{ success: boolean; firestoreSynced: boolean; error?: string }> {
  const { db } = getSafeFirebase();
  if (!db) {
    return { success: true, firestoreSynced: false };
  }

  try {
    const userDocRef = doc(db, "users", requestUser.uid);
    await setDoc(
      userDocRef,
      {
        uid: requestUser.uid,
        name: requestUser.name,
        email: requestUser.email,
        status: requestUser.status || "Pending",
        role: requestUser.role || null,
        requestedAt: requestUser.requestedAt || new Date().toISOString(),
        reviewedAt: requestUser.reviewedAt || null,
        reviewedBy: requestUser.reviewedBy || null,
      },
      { merge: true }
    );
    return { success: true, firestoreSynced: true };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("Firestore document write skipped or failed:", errorMsg);
    return { success: false, firestoreSynced: false, error: errorMsg };
  }
}

/**
 * Updates a user document in Firestore 'users' collection on approval or rejection
 */
export async function updateUserStatusInFirestore(
  uid: string,
  status: AuthorizationStatus,
  role?: UserRole | string | null,
  reviewedBy?: string
): Promise<{ success: boolean; firestoreSynced: boolean; error?: string }> {
  const { db } = getSafeFirebase();
  if (!db) {
    return { success: true, firestoreSynced: false };
  }

  try {
    const userDocRef = doc(db, "users", uid);
    const updatePayload: Record<string, unknown> = {
      status,
      reviewedAt: new Date().toISOString(),
      reviewedBy: reviewedBy || "System Root",
    };
    if (role !== undefined) {
      updatePayload.role = role;
    }
    await updateDoc(userDocRef, updatePayload);
    return { success: true, firestoreSynced: true };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("Firestore user status update skipped:", errorMsg);
    return { success: false, firestoreSynced: false, error: errorMsg };
  }
}

/**
 * Appends an audit record to the 'activityLogs' Firestore collection
 */
export async function appendActivityLogToFirestore(logItem: {
  action: string;
  targetUser?: string;
  executedBy?: string;
  details?: string;
  module?: string;
  recordId?: string;
  payload?: string;
  userEmail?: string;
  userName?: string;
  userRole?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ success: boolean; firestoreSynced: boolean; id?: string; error?: string }> {
  const { db } = getSafeFirebase();
  if (!db) {
    return { success: true, firestoreSynced: false };
  }

  try {
    const logRef = doc(collection(db, "activityLogs"));
    const timestamp = new Date().toISOString();
    const docData = {
      id: logRef.id,
      timestamp,
      action: logItem.action,
      targetUser: logItem.targetUser || logItem.userEmail || "",
      executedBy: logItem.executedBy || logItem.userName || "System",
      details: logItem.details || logItem.payload || "",
      module: logItem.module || "Auth",
      recordId: logItem.recordId || logRef.id,
      metadata: logItem.metadata || {},
      result: "SUCCESS",
    };
    await setDoc(logRef, docData);
    return { success: true, firestoreSynced: true, id: logRef.id };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("Firestore activityLog write skipped:", errorMsg);
    return { success: false, firestoreSynced: false, error: errorMsg };
  }
}

/**
 * Executes Google OAuth requesting ONLY 'email' and 'profile' scopes.
 * STRICT NO-IMAGE POLICY: Discards any profile photo or avatar URLs.
 */
export async function executeGoogleSyncAuth(): Promise<{
  success: boolean;
  user?: {
    uid: string;
    email: string;
    displayName: string;
  };
  useFallbackSimulation?: boolean;
  error?: string;
}> {
  const { auth } = getSafeFirebase();

  if (!auth) {
    return {
      success: false,
      useFallbackSimulation: true,
      error: "Firebase Auth not provisioned with live credentials. Falling back to Google identity selector.",
    };
  }

  try {
    const provider = new GoogleAuthProvider();
    provider.addScope("profile");
    provider.addScope("email");
    const result = await signInWithPopup(auth, provider);
    const fbUser: FirebaseUser = result.user;

    // Discard any avatarUrl / photoURL per strict no-image policy
    return {
      success: true,
      user: {
        uid: fbUser.uid,
        email: fbUser.email || "unknown@gmail.com",
        displayName: fbUser.displayName || "Google User",
      },
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("Firebase Google popup error or sandbox limitation:", errorMsg);
    return {
      success: false,
      useFallbackSimulation: true,
      error: errorMsg,
    };
  }
}
