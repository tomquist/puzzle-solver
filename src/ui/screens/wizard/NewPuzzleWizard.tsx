/**
 * New-puzzle wizard: (1) box photo → (2) corners → (3) details → (4) reference & close-ups →
 * (5) save. Image processing goes through the pipeline; images handed to it are cloned because
 * the worker client may transfer (detach) their buffers.
 */
import { useEffect, useRef, useState } from 'react';
import type { Quad } from '../../../cv/geometry';
import { cloneRGBA } from '../../../cv/image';
import type { BoxDetection } from '../../../model/types';
import { blobToRGBA, createObjectUrl, isQuotaError, revokeObjectUrl } from '../../../platform/imageio';
import { newId } from '../../../storage/types';
import { CameraCapture } from '../../components/CameraCapture';
import { Banner, ErrorState, errorText, ProgressBar, Spinner } from '../../components/Feedback';
import { TopBar } from '../../components/TopBar';
import { usePipeline } from '../../context/PipelineContext';
import { useRepository } from '../../context/RepositoryContext';
import { navigate } from '../../hooks/useHashRoute';
import { composeScale } from '../../lib/quality';
import { href } from '../../lib/routes';
import { CornersStep } from './CornersStep';
import { DetailsStep, EMPTY_DETAILS, type DetailsForm } from './DetailsStep';
import { ReferenceStep } from './ReferenceStep';
import { saveNewPuzzle } from './savePuzzle';
import { encodeImage, releaseImage, type Closeup, type EncodedImage, type PuzzleDetails } from './types';

type Step = 'photo' | 'corners' | 'details' | 'reference' | 'save';
const STEPS: { id: Step; title: string }[] = [
  { id: 'photo', title: 'Box photo' },
  { id: 'corners', title: 'Find the picture' },
  { id: 'details', title: 'Details' },
  { id: 'reference', title: 'Check the picture' },
  { id: 'save', title: 'Save' },
];

export function NewPuzzleWizard() {
  const pipeline = usePipeline();
  const { repo, requestPersist } = useRepository();
  const [step, setStep] = useState<Step>('photo');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const [photo, setPhoto] = useState<EncodedImage>();
  const [photoBitmap, setPhotoBitmap] = useState<ImageBitmap>();
  const [detection, setDetection] = useState<BoxDetection>();
  const [quad, setQuad] = useState<Quad>();
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [quadAspect, setQuadAspect] = useState(4 / 3);

  const [form, setForm] = useState<DetailsForm>(EMPTY_DETAILS);
  const [details, setDetails] = useState<PuzzleDetails>();
  const [base, setBase] = useState<EncodedImage>();
  const [composed, setComposed] = useState<{ image: EncodedImage; ids: string }>();
  const [closeups, setCloseups] = useState<Closeup[]>([]);
  const [composing, setComposing] = useState(false);
  const [saveState, setSaveState] = useState<{ message: string; fraction: number; error?: string }>();

  // Release object URLs / bitmaps when they are replaced or the wizard closes.
  useEffect(() => () => releaseImage(photo), [photo]);
  useEffect(() => () => photoBitmap?.close(), [photoBitmap]);
  useEffect(() => () => releaseImage(base), [base]);
  useEffect(() => () => releaseImage(composed?.image), [composed]);
  const closeupsRef = useRef(closeups);
  closeupsRef.current = closeups;
  useEffect(() => () => closeupsRef.current.forEach((c) => revokeObjectUrl(c.previewUrl)), []);

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const okIds = closeups.filter((c) => c.status === 'ok').map((c) => c.id).join(',');
  const reference = composed?.image ?? base;
  const composedStale = !composed || composed.ids !== okIds;

  // --- Step 1: photo -------------------------------------------------------------------------
  const onPhoto = async (file: Blob) => {
    setError(undefined);
    setBusy('Reading the photo…');
    try {
      const rgba = await blobToRGBA(file, 4096);
      const encoded = await encodeImage(rgba);
      const bitmap = await createImageBitmap(encoded.blob);
      setBusy('Looking for the puzzle picture…');
      const det = await pipeline.detectBox(cloneRGBA(rgba));
      setPhoto(encoded);
      setPhotoBitmap(bitmap);
      setDetection(det);
      setQuad(det.quad);
      setCandidateIndex(0);
      setBase(undefined);
      setComposed(undefined);
      setStep('corners');
    } catch (e) {
      setError(errorText(e, 'This photo could not be read. Try another one.'));
    } finally {
      setBusy(undefined);
    }
  };

  // --- Step 2 → 3 ----------------------------------------------------------------------------
  const toDetails = async () => {
    if (!quad) return;
    try {
      const s = await pipeline.suggestRectifiedSize(quad);
      setQuadAspect(s.width / s.height);
    } catch {
      // keep previous estimate
    }
    setStep('details');
  };

  // --- Step 3 → 4: rectify -------------------------------------------------------------------
  const onDetails = async (d: PuzzleDetails) => {
    if (!photo || !quad) return;
    setError(undefined);
    setBusy('Straightening the picture…');
    try {
      const aspect = d.physicalSize ? d.physicalSize.width / d.physicalSize.height : undefined;
      const size = await pipeline.suggestRectifiedSize(quad, aspect);
      const rgba = await pipeline.rectify(cloneRGBA(photo.rgba), quad, size.width, size.height);
      const encoded = await encodeImage(rgba);
      setDetails(d);
      setBase(encoded);
      setComposed(undefined);
      // Close-ups were registered against the previous reference.
      closeups.forEach((c) => revokeObjectUrl(c.previewUrl));
      setCloseups([]);
      setStep('reference');
    } catch (e) {
      setError(errorText(e, 'The picture could not be straightened.'));
    } finally {
      setBusy(undefined);
    }
  };

  // --- Step 4: close-ups ---------------------------------------------------------------------
  const update = (id: string, patch: Partial<Closeup>) => setCloseups((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const addCloseups = async (files: Blob[]) => {
    if (!base) return;
    const entries: Closeup[] = files.map((f) => ({ id: newId(), previewUrl: createObjectUrl(f), status: 'reading' }));
    setCloseups((cs) => [...cs, ...entries]);
    for (let i = 0; i < files.length; i++) {
      const id = entries[i].id;
      try {
        const rgba = await blobToRGBA(files[i], 4096);
        update(id, { status: 'registering', rgba });
        const reg = await pipeline.registerCloseup(cloneRGBA(base.rgba), cloneRGBA(rgba));
        update(id, reg ? { status: 'ok', registration: reg } : { status: 'failed' });
      } catch (e) {
        update(id, { status: 'failed', error: errorText(e, 'This photo could not be read.') });
      }
    }
  };

  const removeCloseup = (id: string) => {
    setCloseups((cs) => {
      const c = cs.find((x) => x.id === id);
      revokeObjectUrl(c?.previewUrl);
      return cs.filter((x) => x.id !== id);
    });
  };

  const compose = async () => {
    if (!base) return;
    const ok = closeups.filter((c) => c.status === 'ok' && c.rgba && c.registration);
    if (!ok.length) return;
    setComposing(true);
    setError(undefined);
    try {
      const scale = composeScale(ok.map((c) => c.registration!.scaleGain), Math.max(base.width, base.height));
      const rgba = await pipeline.composeHighRes(
        cloneRGBA(base.rgba),
        ok.map((c) => ({ image: cloneRGBA(c.rgba!), registration: c.registration! })),
        { scale },
      );
      setComposed({ image: await encodeImage(rgba), ids: ok.map((c) => c.id).join(',') });
    } catch (e) {
      setError(errorText(e, 'The sharper picture could not be built.'));
    } finally {
      setComposing(false);
    }
  };

  // --- Step 5: save --------------------------------------------------------------------------
  const save = async () => {
    if (!photo || !quad || !details || !base || !reference) return;
    setStep('save');
    setSaveState({ message: 'Saving…', fraction: 0 });
    try {
      const puzzle = await saveNewPuzzle(
        repo,
        {
          details,
          photo,
          quad,
          reference,
          referenceScale: reference.width / base.width,
          closeups: composed ? closeups.filter((c) => composed.ids.split(',').includes(c.id)) : [],
        },
        (message, fraction) => setSaveState({ message, fraction }),
      );
      void requestPersist();
      navigate(href.puzzle(puzzle.id), true);
    } catch (e) {
      setSaveState({
        message: '',
        fraction: 0,
        error: isQuotaError(e) ? 'Your browser’s storage is full. Delete old puzzles or scans and try again.' : errorText(e, 'The puzzle could not be saved.'),
      });
    }
  };

  const back = () => {
    setError(undefined);
    if (step === 'photo') navigate(href.home());
    else if (step === 'corners') setStep('photo');
    else if (step === 'details') setStep('corners');
    else if (step === 'reference') setStep('details');
    else if (step === 'save' && saveState?.error) setStep('reference');
  };

  return (
    <>
      <TopBar
        title="New puzzle"
        subtitle={`Step ${stepIndex + 1} of ${STEPS.length} · ${STEPS[stepIndex].title}`}
        onBack={step === 'save' && !saveState?.error ? undefined : back}
        back={step === 'save' && !saveState?.error ? undefined : href.home()}
      >
        <div className="stepper" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s.id} className={i < stepIndex ? 'done' : i === stepIndex ? 'current' : ''} />
          ))}
        </div>
      </TopBar>
      <main className="page narrow stack" data-testid={`wizard-${step}`}>
        {error && (
          <Banner tone="error" onDismiss={() => setError(undefined)}>
            {error}
          </Banner>
        )}
        {busy && step !== 'details' ? (
          <div className="busy-card">
            <Spinner label={busy} />
          </div>
        ) : step === 'photo' ? (
          <CameraCapture context="box" onCapture={onPhoto} />
        ) : step === 'corners' && photo && detection && quad ? (
          <CornersStep
            photo={photo}
            source={photoBitmap}
            detection={detection}
            quad={quad}
            candidateIndex={candidateIndex}
            onQuad={setQuad}
            onCandidate={(i) => {
              setCandidateIndex(i);
              setQuad(i === 0 ? detection.quad : detection.candidates[i].quad);
            }}
            onNext={toDetails}
          />
        ) : step === 'details' ? (
          <DetailsStep form={form} onChange={setForm} quadAspect={quadAspect} busy={!!busy} onNext={onDetails} />
        ) : step === 'reference' && reference && base && details ? (
          <ReferenceStep
            reference={reference}
            baseWidth={base.width}
            grid={details.grid}
            closeups={closeups}
            composing={composing}
            composedStale={composedStale}
            onAddCloseups={(f) => void addCloseups(f)}
            onRemoveCloseup={removeCloseup}
            onCompose={() => void compose()}
            onNext={() => void save()}
          />
        ) : step === 'save' && saveState ? (
          saveState.error ? (
            <ErrorState title="Not saved" error={saveState.error} onRetry={() => void save()} />
          ) : (
            <div className="busy-card">
              <ProgressBar value={saveState.fraction} label={saveState.message} />
            </div>
          )
        ) : (
          <Spinner />
        )}
      </main>
    </>
  );
}
