package main

import "io"

// teeReadCloser reads from r and writes everything it reads to w (a
// pipe writer) so a single origin response body can be streamed to the
// client and to the cache upload at the same time.
type teeReadCloser struct {
	r io.ReadCloser
	w *io.PipeWriter
}

func (t *teeReadCloser) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if n > 0 {
		if _, werr := t.w.Write(p[:n]); werr != nil {
			t.r.Close()
			return 0, werr
		}
	}
	if err != nil {
		t.w.CloseWithError(err)
	}
	return n, err
}

func (t *teeReadCloser) Close() error {
	err := t.r.Close()
	t.w.Close()
	return err
}