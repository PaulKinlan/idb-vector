// Build: sh tools/build-cosine-wasm.sh. No libc; SIMD128 is required.
#include <wasm_simd128.h>
static float sum(v128_t v) {
  return wasm_f32x4_extract_lane(v,0) + wasm_f32x4_extract_lane(v,1)
       + wasm_f32x4_extract_lane(v,2) + wasm_f32x4_extract_lane(v,3);
}
void score(const float *vectors, const float *query, float *out, int count, int dim) {
  for (int row=0; row<count; row++) {
    v128_t dot=wasm_f32x4_splat(0), aa=dot, bb=dot;
    int j=0;
    for (; j+4<=dim; j+=4) {
      v128_t a=wasm_v128_load(vectors+row*dim+j), b=wasm_v128_load(query+j);
      dot=wasm_f32x4_add(dot,wasm_f32x4_mul(a,b));
      aa=wasm_f32x4_add(aa,wasm_f32x4_mul(a,a));
      bb=wasm_f32x4_add(bb,wasm_f32x4_mul(b,b));
    }
    float d=sum(dot), a=sum(aa), b=sum(bb);
    for (;j<dim;j++) {float x=vectors[row*dim+j],y=query[j]; d+=x*y;a+=x*x;b+=y*y;}
    out[row]=d/(__builtin_sqrtf(a)*__builtin_sqrtf(b));
  }
}
