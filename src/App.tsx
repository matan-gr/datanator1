/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import Dashboard from './components/Dashboard';
import { Toaster } from './components/ui/sonner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeProvider } from 'next-themes';

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="light">
      <ErrorBoundary>
        <div className="min-h-screen bg-background font-sans antialiased">
          <Dashboard />
          <Toaster />
        </div>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
