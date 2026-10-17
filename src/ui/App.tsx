import { PipelineProvider } from './context/PipelineContext';
import { PuzzleProvider } from './context/PuzzleContext';
import { RepositoryProvider } from './context/RepositoryContext';
import { EmptyState } from './components/Feedback';
import { TopBar } from './components/TopBar';
import { useHashRoute } from './hooks/useHashRoute';
import { href } from './lib/routes';
import { HomeScreen } from './screens/HomeScreen';
import { NewPuzzleWizard } from './screens/wizard/NewPuzzleWizard';
import { PuzzleWorkspace } from './screens/workspace/PuzzleWorkspace';
import { ScanResultScreen } from './screens/scan/ScanResultScreen';
import type { PipelineApi } from '../worker/api';

export function App({ pipeline }: { pipeline?: PipelineApi } = {}) {
  return (
    <RepositoryProvider>
      <PipelineProvider pipeline={pipeline}>
        <Router />
      </PipelineProvider>
    </RepositoryProvider>
  );
}

function Router() {
  const route = useHashRoute();
  switch (route.name) {
    case 'home':
      return <HomeScreen />;
    case 'new':
      return <NewPuzzleWizard />;
    case 'puzzle':
      return (
        <PuzzleProvider key={route.id} id={route.id}>
          <PuzzleWorkspace tab={route.tab} />
        </PuzzleProvider>
      );
    case 'scan':
      return (
        <PuzzleProvider key={route.id} id={route.id}>
          <ScanResultScreen key={route.scanId} scanId={route.scanId} />
        </PuzzleProvider>
      );
    case 'notFound':
      return (
        <>
          <TopBar title="Not found" back={href.home()} />
          <main className="page">
            <EmptyState
              title="This page doesn’t exist"
              actions={
                <a className="btn btn-primary" href={href.home()}>
                  Go to my puzzles
                </a>
              }
            >
              <p className="muted">{route.path}</p>
            </EmptyState>
          </main>
        </>
      );
  }
}
