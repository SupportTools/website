---
title: "Implementing JWT Authentication in React with React Router"
date: 2026-10-01T09:00:00-05:00
draft: false
tags: ["React", "JWT", "Authentication", "React Router", "JavaScript", "Frontend"]
categories:
- React
- Security
- Frontend
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing secure JWT authentication in React applications with react-router, including protected routes and axios integration"
more_link: "yes"
url: "/jwt-authentication-react-router/"
---

Implementing proper authentication is crucial for modern web applications. In this guide, we'll explore how to integrate JWT (JSON Web Token) authentication in React applications using React Router to create protected routes and manage user sessions effectively.

<!--more-->

# [Introduction](#introduction)

Authentication is a fundamental aspect of web applications that require user-specific data and protected resources. JSON Web Tokens (JWT) provide a stateless, secure method for authenticating users and managing sessions. In this tutorial, we'll build a complete authentication system in React that includes:

- Centralized authentication state management with Context API
- Protected routes with React Router
- Token storage and management
- Automatic request authorization with Axios
- Login and logout functionality

By the end of this guide, you'll have a solid foundation for implementing secure authentication in your React applications.

## [Project Setup](#project-setup)

Let's start by creating a new React project and installing the necessary dependencies.

```bash
# Create a new React project using Vite
npm create vite@latest react-auth-demo
# Select React as the framework and JavaScript as the variant

# Navigate to the project directory
cd react-auth-demo

# Install dependencies
npm install

# Install react-router-dom and axios
npm install react-router-dom axios
```

## [Creating the Authentication Context](#auth-context)

The first step in implementing our authentication system is to create an AuthProvider component and an associated AuthContext. This will allow us to store and share authentication-related data and functions throughout our application.

Create a new file at `src/provider/authProvider.jsx`:

```jsx
import axios from "axios";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

// Create a context for authentication data
const AuthContext = createContext();

// AuthProvider component to wrap the app and provide authentication context
const AuthProvider = ({ children }) => {
  // State to hold the authentication token
  const [token, setToken_] = useState(localStorage.getItem("token"));

  // Function to set the authentication token
  const setToken = (newToken) => {
    setToken_(newToken);
  };

  // Effect to update axios headers and localStorage when token changes
  useEffect(() => {
    if (token) {
      axios.defaults.headers.common["Authorization"] = "Bearer " + token;
      localStorage.setItem('token', token);
    } else {
      delete axios.defaults.headers.common["Authorization"];
      localStorage.removeItem('token');
    }
  }, [token]);

  // Memoized value of the authentication context
  const contextValue = useMemo(
    () => ({
      token,
      setToken,
    }),
    [token]
  );

  // Provide the authentication context to the children components
  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

// Custom hook to use the auth context
export const useAuth = () => {
  return useContext(AuthContext);
};

export default AuthProvider;
```

This `AuthProvider` component manages:

1. **Token State**: Stores the JWT token in state and initializes it from localStorage
2. **Token Updates**: Provides a function to update the token
3. **Side Effects**: Updates axios headers and localStorage when the token changes
4. **Context Value**: Provides the token and setToken function to all children components

## [Creating a Protected Route Component](#protected-route)

Next, we'll create a component to protect routes that require authentication. This component will redirect unauthenticated users to the login page.

Create a new file at `src/routes/ProtectedRoute.jsx`:

```jsx
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../provider/authProvider";

export const ProtectedRoute = () => {
  const { token } = useAuth();

  // If the user is not authenticated, redirect to the login page
  if (!token) {
    return <Navigate to="/login" />;
  }

  // If the user is authenticated, render the child routes
  return <Outlet />;
};
```

The `ProtectedRoute` component serves as a wrapper for authenticated routes. It checks if the user has a valid token and either allows access to the protected route or redirects to the login page.

## [Setting Up Application Routes](#application-routes)

Now, let's define our application routes, differentiating between public routes, authenticated routes, and routes for non-authenticated users.

Create a new file at `src/routes/index.jsx`:

```jsx
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { useAuth } from "../provider/authProvider";
import { ProtectedRoute } from "./ProtectedRoute";
import Login from "../pages/Login";
import Logout from "../pages/Logout";

const Routes = () => {
  const { token } = useAuth();

  // Routes accessible to all users
  const routesForPublic = [
    {
      path: "/service",
      element: <div>Service Page (Public)</div>,
    },
    {
      path: "/about-us",
      element: <div>About Us (Public)</div>,
    },
  ];

  // Routes accessible only to authenticated users
  const routesForAuthenticatedOnly = [
    {
      path: "/",
      element: <ProtectedRoute />,
      children: [
        {
          path: "/",
          element: <div>Dashboard (Protected)</div>,
        },
        {
          path: "/profile",
          element: <div>User Profile (Protected)</div>,
        },
        {
          path: "/settings",
          element: <div>Settings (Protected)</div>,
        },
        {
          path: "/logout",
          element: <Logout />,
        },
      ],
    },
  ];

  // Routes accessible only to non-authenticated users
  const routesForNotAuthenticatedOnly = [
    {
      path: "/",
      element: <div>Welcome to our app! Please log in to access your dashboard.</div>,
    },
    {
      path: "/login",
      element: <Login />,
    },
    {
      path: "/register",
      element: <div>Register Page</div>,
    },
  ];

  // Combine routes based on authentication status
  const router = createBrowserRouter([
    ...routesForPublic,
    ...(!token ? routesForNotAuthenticatedOnly : []),
    ...routesForAuthenticatedOnly,
  ]);

  return <RouterProvider router={router} />;
};

export default Routes;
```

In this configuration:

1. **Public routes** are accessible to all users regardless of authentication status
2. **Authenticated routes** are wrapped in the ProtectedRoute component and only accessible to authenticated users
3. **Non-authenticated routes** are only available to users who aren't logged in

The key part of this implementation is how we conditionally include routes based on the authentication status:

```jsx
const router = createBrowserRouter([
  ...routesForPublic,
  ...(!token ? routesForNotAuthenticatedOnly : []),
  ...routesForAuthenticatedOnly,
]);
```

When a user is not authenticated, the non-authenticated routes are included, but when a user is authenticated, those routes are excluded from the router configuration.

## [Implementing Login and Logout Pages](#login-logout)

Now, let's create the login and logout functionality.

Create a new file at `src/pages/Login.jsx`:

```jsx
import { useNavigate } from "react-router-dom";
import { useAuth } from "../provider/authProvider";
import { useState } from "react";

const Login = () => {
  const { setToken } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // In a real application, this would be an API call
  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    
    try {
      // This is where you would make an API call to authenticate
      // For demonstration purposes, we're using a timeout to simulate an API call
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // In a real application, you would get a JWT from your backend
      // const response = await axios.post('/api/auth/login', { username, password });
      // setToken(response.data.token);
      
      // Using a dummy token for demonstration
      setToken("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
      
      // Navigate to the dashboard
      navigate("/", { replace: true });
    } catch (err) {
      setError("Failed to log in. Please check your credentials and try again.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <h1>Login</h1>
      {error && <div className="error">{error}</div>}
      <form onSubmit={handleLogin}>
        <div className="form-group">
          <label htmlFor="username">Username</label>
          <input
            type="text"
            id="username"
            placeholder="Enter your username"
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="password">Password</label>
          <input
            type="password"
            id="password"
            placeholder="Enter your password"
            required
          />
        </div>
        <button type="submit" disabled={isLoading}>
          {isLoading ? "Logging in..." : "Login"}
        </button>
      </form>
    </div>
  );
};

export default Login;
```

Create a new file at `src/pages/Logout.jsx`:

```jsx
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../provider/authProvider";

const Logout = () => {
  const { setToken } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // Clear the token
    setToken(null);
    
    // Navigate to the home page
    navigate("/", { replace: true });
  }, [setToken, navigate]);

  return <div>Logging out...</div>;
};

export default Logout;
```

## [Integrating Everything in App.jsx](#app-integration)

Finally, let's update our App.jsx file to use the AuthProvider and Routes components:

```jsx
import AuthProvider from "./provider/authProvider";
import Routes from "./routes";

function App() {
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}

export default App;
```

## [Enhanced Security Considerations](#security-considerations)

While the implementation above provides a functional authentication system, there are some important security considerations to keep in mind:

### Token Storage Security

Storing JWTs in localStorage can pose security risks, particularly related to XSS attacks. Consider these alternatives:

1. **HttpOnly Cookies**: More secure against XSS attacks, but requires backend configuration
   
2. **Memory-only Storage**: Store tokens only in memory (React state) for the duration of the session
   ```jsx
   // Remove localStorage usage and keep tokens only in state
   const [token, setToken_] = useState(null);
   ```

3. **Token Refresh Strategy**: Implement a token refresh mechanism using refresh tokens
   ```jsx
   // Example of token refresh logic
   const refreshToken = async () => {
     try {
       const response = await axios.post('/api/auth/refresh', {
         refreshToken: localStorage.getItem('refreshToken')
       });
       setToken(response.data.token);
     } catch (err) {
       // Handle token refresh failure
       setToken(null);
     }
   };
   ```

### JWT Validation

It's important to validate JWTs on the client-side, checking for:

1. **Token Expiration**: Verify that the token hasn't expired
2. **Token Structure**: Ensure the token has the correct format
3. **Token Signature**: Validate the token's signature if possible

Here's an example of token validation:

```jsx
const validateToken = (token) => {
  if (!token) return false;
  
  try {
    // Parse the token (split by dot and decode the payload)
    const payload = JSON.parse(atob(token.split('.')[1]));
    
    // Check if token has expired
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return false;
    }
    
    return true;
  } catch (e) {
    return false;
  }
};
```

## [Advanced Authorization Patterns](#advanced-patterns)

For more complex applications, you might need to implement role-based access control (RBAC):

```jsx
// Enhanced AuthContext with user roles
const AuthContext = createContext();

const AuthProvider = ({ children }) => {
  const [token, setToken_] = useState(localStorage.getItem("token"));
  const [userRoles, setUserRoles] = useState([]);
  
  // Function to set the authentication token and extract roles
  const setToken = (newToken) => {
    setToken_(newToken);
    
    if (newToken) {
      // Extract user roles from the token
      const payload = JSON.parse(atob(newToken.split('.')[1]));
      setUserRoles(payload.roles || []);
    } else {
      setUserRoles([]);
    }
  };
  
  // Check if user has a specific role
  const hasRole = (role) => {
    return userRoles.includes(role);
  };
  
  // Context value with token, roles, and helper functions
  const contextValue = useMemo(
    () => ({
      token,
      userRoles,
      setToken,
      hasRole,
    }),
    [token, userRoles]
  );
  
  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};
```

Then you can create role-based protected routes:

```jsx
export const AdminRoute = () => {
  const { token, hasRole } = useAuth();

  if (!token || !hasRole('admin')) {
    return <Navigate to="/unauthorized" />;
  }

  return <Outlet />;
};
```

# [Conclusion](#conclusion)

We've built a comprehensive JWT authentication system in React with the following features:

1. Centralized authentication state management with Context API
2. Protected routes using React Router
3. Public and authenticated route separation
4. Login and logout functionality
5. Axios integration for automatic request authorization

This implementation provides a solid foundation that you can extend with additional features such as:

- Registration functionality
- Password reset flows
- Multi-factor authentication
- Role-based access control
- Token refresh mechanisms

Remember that client-side authentication is just one piece of the puzzle. A secure authentication system also requires proper backend implementation with secure token generation, validation, and storage.

For production applications, consider using established authentication libraries and services like Auth0, Firebase Authentication, or AWS Cognito, which provide battle-tested implementations of these concepts along with additional security features.