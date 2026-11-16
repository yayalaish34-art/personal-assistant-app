import { useEffect, useRef, useState } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform } from 'react-native';

/**
 * How far the keyboard reaches up into the page, in points; 0 while it is down.
 *
 * For a page that ends at the bottom of the screen — the assistant's sheet, or
 * a transparent `Modal` — the overlap is simply how far the keyboard's top sits
 * above the screen's foot.
 *
 * Not `KeyboardAvoidingView`: in an iOS sheet that starts below the top of the
 * screen, KAV compares the sheet's own frame against the keyboard's screen
 * position, so it falls short by exactly that gap and the field stays under
 * the keys. It also overwrites the view's bottom padding.
 *
 * Android resizes the window itself (soft-input mode), so nothing is done there.
 *
 * `enabled` is for a screen that only needs it while one of its sheets is
 * open: off, it listens to nothing and stays at 0, so the keys coming up for
 * the page's own fields don't re-render the page.
 */
export function useKeyboardLift(onShow?: () => void, enabled = true): number {
  const [lift, setLift] = useState(0);
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;

  useEffect(() => {
    if (Platform.OS !== 'ios' || !enabled) {
      setLift(0);
      return;
    }
    const follow = (next: number, duration: number) => {
      // Move with the keyboard, on its own curve, rather than jumping after it.
      if (duration > 0) {
        LayoutAnimation.configureNext({
          duration,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      setLift(next);
    };
    const change = Keyboard.addListener('keyboardWillChangeFrame', (e) => {
      const overlap = Math.max(Dimensions.get('screen').height - e.endCoordinates.screenY, 0);
      follow(overlap, e.duration);
      if (overlap > 0) onShowRef.current?.();
    });
    const hide = Keyboard.addListener('keyboardWillHide', (e) => follow(0, e.duration));
    return () => {
      change.remove();
      hide.remove();
    };
  }, [enabled]);

  return lift;
}
