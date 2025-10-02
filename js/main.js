// ===== Constants & Styles =====
const SNAP_STEP = 1;
const LABEL_SIZE = 0.2;
const LABEL_OFFSET = 0.5;
const HUMAN_HEIGHT = 1.75; // meters (5'9")
const BOX_COLORS = { hover:0x99ccff, selected:0x0000ff, editing:0xffffff };

// ===== Scene setup =====
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 1000);
camera.position.set(3,3,6);

const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const orbit = new THREE.OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

let groundSize = 20;
orbit.minDistance = 1;
orbit.maxDistance = groundSize * 1.5;

const transform = new THREE.TransformControls(camera, renderer.domElement);
scene.add(transform);

let selectedObject = null;
let selectedObjects = [];
let hoveredObject = null;
let draggedItem = null;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1);
dirLight.position.set(5,10,7);
scene.add(dirLight);

let grid = new THREE.GridHelper(groundSize, groundSize, 0x888888, 0x444444);
grid.userData.isSelectable = false;
grid.raycast = () => {};
scene.add(grid);

let ruler = null;
let humanGuide = null;

// Human guide (reference only)
humanGuide = createHumanGuide(HUMAN_HEIGHT);
scene.add(humanGuide);


// ===== UI refs =====
const loader = new THREE.GLTFLoader();
const fileInput = document.getElementById("file");
const modelList = document.getElementById("modelList");
const propertiesPanel = document.getElementById("properties");
const snapCheckbox = document.getElementById("snap");
const canvasSizeInput = document.getElementById("canvasSize");
const btnTranslate = document.getElementById("translate");
const btnRotate = document.getElementById("rotate");
const btnScale = document.getElementById("scale");
const btnDelete = document.getElementById("delete");
const btnUndo = document.getElementById("undo");
const btnResetCamera = document.getElementById("resetCamera");

let modelCounter = 1;

let loadedFont = null;
const fontLoader = new THREE.FontLoader();
fontLoader.load('https://threejs.org/examples/fonts/helvetiker_regular.typeface.json', font => {
  loadedFont = font;
  ruler = createRuler(groundSize, 1);
  addRulerLabels(ruler, groundSize, 1, loadedFont);
  ruler.userData.isSelectable = false;
  scene.add(ruler);
});

// ===== Utilities =====
function getBox(obj){ return new THREE.Box3().setFromObject(obj); }

function updateAllVisuals(obj){
  if(!obj) return;
  updateModelProperties(obj);
  updatePropertiesPanel(obj);
  updateBoxHelper(obj);
  
  // If this is a group, also update child bounding boxes
  if (obj.userData?.isEditorGroup) {
    updateChildBoundingBoxes(obj);
  }
  
  // Only add dimension labels for selected objects
  if(selectedObjects.includes(obj)) {
    addBoundingBoxDimensions(obj);
  }
}

function cleanupObject(obj){
  if (!obj) return;
  if (obj.userData.boxHelper) {
    scene.remove(obj.userData.boxHelper);
    obj.userData.boxHelper.geometry?.dispose();
    obj.userData.boxHelper.material?.dispose();
    delete obj.userData.boxHelper;
  }
  if (obj.userData.parentBoxHelper) {
    scene.remove(obj.userData.parentBoxHelper);
    obj.userData.parentBoxHelper.geometry?.dispose();
    obj.userData.parentBoxHelper.material?.dispose();
    delete obj.userData.parentBoxHelper;
  }
  if (obj.userData.dimGroup) {
    scene.remove(obj.userData.dimGroup);
    obj.userData.dimGroup.traverse(c=>{
      c.geometry?.dispose();
      c.material?.dispose();
    });
    delete obj.userData.dimGroup;
  }
  if (obj.userData.listItem) {
    const li = obj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if (next && next.tagName === "UL") next.remove();
    delete obj.userData.listItem;
  }
}

function snapUniformScale(obj, step=SNAP_STEP){
  const box = getBox(obj);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const snapped = Math.max(step, Math.round(maxDim/step)*step);
  if (maxDim > 0) obj.scale.multiplyScalar(snapped/maxDim);
}

function clampToCanvas(obj){
  const half = groundSize/2;
  const box = getBox(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const minX = center.x - size.x/2, maxX = center.x + size.x/2;
  const minZ = center.z - size.z/2, maxZ = center.z + size.z/2;
  if (minX < -half) obj.position.x += -half - minX;
  if (maxX >  half) obj.position.x -= maxX - half;
  if (minZ < -half) obj.position.z += -half - minZ;
  if (maxZ >  half) obj.position.z -= maxZ - half;
  if (box.min.y < 0) obj.position.y += -box.min.y;
}

function updateModelProperties(model){
  if(!model) return;
  const box = getBox(model);
  const size = box.getSize(new THREE.Vector3());
  model.userData.properties = {
    pos: model.position.clone(),
    scl: model.scale.clone(),
    size: size.clone()
  };
}

function updatePropertiesPanel(model){
  if(!model || !model.userData.properties){
    propertiesPanel.textContent = "";
    return;
  }
  const p = model.userData.properties;
  propertiesPanel.textContent =
    `Position: (${p.pos.x.toFixed(2)}, ${p.pos.y.toFixed(2)}, ${p.pos.z.toFixed(2)})\n`+
    `Scale: (${p.scl.x.toFixed(2)}, ${p.scl.y.toFixed(2)}, ${p.scl.z.toFixed(2)})\n`+
    `Bounds: (${p.size.x.toFixed(2)}, ${p.size.y.toFixed(2)}, ${p.size.z.toFixed(2)})`;
}

function updateTransformButtonStates(){
  const editingAllowed = isEditingAllowed();
  const buttons = [btnTranslate, btnRotate, btnScale];
  
  buttons.forEach(btn => {
    if (editingAllowed) {
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    } else {
      btn.disabled = true;
      btn.style.opacity = "0.5";
      btn.style.cursor = "not-allowed";
    }
  });
  
  // Detach transform gizmo if editing is not allowed
  if (!editingAllowed) {
    transform.detach();
  } else if (selectedObject) {
    // Reattach to the selected object if editing is allowed
    transform.attach(selectedObject);
  }
}

function createBoxHelperFor(model){
  const helper = new THREE.BoxHelper(model, BOX_COLORS.selected);
  helper.material.transparent = true;
  helper.material.opacity = 0.9;
  helper.visible = false;
  model.userData.boxHelper = helper;
  scene.add(helper);
}

function updateBoxHelper(model, color=null){
  if (!model?.userData.boxHelper) return;
  model.userData.boxHelper.update();
  if (color) model.userData.boxHelper.material.color.setHex(color);
}

function setHelperVisible(model, visible){
  if(model?.userData.boxHelper) model.userData.boxHelper.visible = !!visible;
}

function createParentBoxHelperFor(parentGroup){
  if (!parentGroup || parentGroup.userData.parentBoxHelper) return;
  const helper = new THREE.BoxHelper(parentGroup, 0x888888); // Gray color for parent
  helper.material.transparent = true;
  helper.material.opacity = 0.5;
  helper.visible = false;
  parentGroup.userData.parentBoxHelper = helper;
  scene.add(helper);
}

function updateParentBoxHelper(parentGroup, color=null){
  if (!parentGroup?.userData.parentBoxHelper) return;
  parentGroup.userData.parentBoxHelper.update();
  if (color) parentGroup.userData.parentBoxHelper.material.color.setHex(color);
}

function setParentHelperVisible(parentGroup, visible){
  if(parentGroup?.userData.parentBoxHelper) parentGroup.userData.parentBoxHelper.visible = !!visible;
}

function showChildBoundingBoxes(group, visible, color = 0x888888, recursive = true){
  if (!group || !group.userData?.isEditorGroup) return;
  
  group.children.forEach(child => {
    // Ensure child has a box helper
    if (!child.userData.boxHelper) {
      createBoxHelperFor(child);
    }
    
    if (visible) {
      child.userData.boxHelper.visible = true;
      child.userData.boxHelper.material.color.setHex(color);
      child.userData.boxHelper.material.opacity = 0.5; // Semi-transparent for child boxes
    } else {
      child.userData.boxHelper.visible = false;
    }
    
    // Recursively handle nested groups
    if (recursive && child.userData?.isEditorGroup) {
      showChildBoundingBoxes(child, visible, color, recursive);
    }
  });
}

function updateChildBoundingBoxes(group, recursive = true){
  if (!group || !group.userData?.isEditorGroup) return;
  
  group.children.forEach(child => {
    if (child.userData.boxHelper) {
      child.userData.boxHelper.update();
    }
    
    // Recursively handle nested groups
    if (recursive && child.userData?.isEditorGroup) {
      updateChildBoundingBoxes(child, recursive);
    }
  });
}

function addBoundingBoxDimensions(model){
  if(!loadedFont) return;
  if(model.userData.dimGroup){
    scene.remove(model.userData.dimGroup);
    model.userData.dimGroup.traverse(c=>{
      c.geometry?.dispose();
      c.material?.dispose();
    });
  }
  const box = getBox(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({color:0xffff00});
  const label = (text,pos)=>{
    const mesh = new THREE.Mesh(
      new THREE.TextGeometry(text,{font:loadedFont,size:LABEL_SIZE,height:0}),
      mat
    );
    mesh.position.copy(pos);
    group.add(mesh);
  };
  label(`${size.x.toFixed(2)}m`, new THREE.Vector3(center.x, box.max.y+0.2, box.min.z-LABEL_OFFSET));
  label(`${size.y.toFixed(2)}m`, new THREE.Vector3(box.max.x+LABEL_OFFSET, center.y, box.min.z-LABEL_OFFSET));
  label(`${size.z.toFixed(2)}m`, new THREE.Vector3(center.x, box.min.y-LABEL_OFFSET, box.max.z+LABEL_OFFSET));
  scene.add(group);
  model.userData.dimGroup = group;
}


// ===== Transforms: initial & helpers =====
function storeInitialTransform(obj){
  obj.userData.initialTransform = {
    pos: obj.position.clone(),
    rot: obj.quaternion.clone(),
    scale: obj.scale.clone()
  };
}

function resetTransform(obj){
  if(!obj.userData.initialTransform) return;
  const t = obj.userData.initialTransform;
  obj.position.copy(t.pos);
  obj.quaternion.copy(t.rot);
  obj.scale.copy(t.scale);
  updateAllVisuals(obj);
}

function dropToFloor(obj){
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  obj.position.y -= box.min.y;
  updateAllVisuals(obj);
}

// ===== Selection validation helpers =====
function isEditingAllowed(){
  // No editing if no objects selected
  if (selectedObjects.length === 0) return false;
  
  // Single object selected
  if (selectedObjects.length === 1) {
    const obj = selectedObjects[0];
    
    // If it's a child object in a group, only allow editing if selected from sidebar
    if (isChildObjectInGroup(obj)) {
      return isChildObjectSelectedFromSidebar(obj);
    }
    
    // Otherwise, always allow editing
    return true;
  }
  
  // Multiple objects selected - only allow if they are all part of the same group
  if (selectedObjects.length > 1) {
    // Check if all selected objects are children of the same group
    const firstParent = selectedObjects[0].parent;
    if (!firstParent || !firstParent.userData?.isEditorGroup) return false;
    
    // All selected objects must be children of the same group
    return selectedObjects.every(obj => obj.parent === firstParent);
  }
  
  return false;
}

function isChildObjectInGroup(obj){
  return obj.parent && obj.parent.userData?.isEditorGroup === true;
}

function isChildObjectSelectedFromSidebar(obj){
  // Check if this object is a child of a group and was selected from sidebar
  if (!isChildObjectInGroup(obj)) return false;
  
  // Check if the object has a list item that's nested under a group
  const listItem = obj.userData?.listItem;
  if (!listItem) return false;
  
  // Check if this list item is nested under a group's child list
  const parentLi = listItem.parentElement;
  if (!parentLi || parentLi.tagName !== 'UL') return false;
  
  const groupLi = parentLi.previousElementSibling;
  if (!groupLi || !groupLi.querySelector('.caret')) return false;
  
  return true;
}

// ===== Selection (unified) =====
function selectObject(obj, additive=false, toggle=false){
  if (!additive && !toggle) {
    selectedObjects.forEach(o=>{
      o.userData.listItem?.classList.remove("selected");
      setHelperVisible(o,false);
      // Hide parent box helper if object is a child in a group
      if (isChildObjectInGroup(o) && o.parent) {
        setParentHelperVisible(o.parent, false);
      }
      // Hide child bounding boxes if object is a group
      if (o.userData?.isEditorGroup) {
        showChildBoundingBoxes(o, false);
      }
      if (o.userData.dimGroup) scene.remove(o.userData.dimGroup);
    });
    selectedObjects = [];
    updateTransformButtonStates();
  }

  if (toggle && selectedObjects.includes(obj)) {
    selectedObjects = selectedObjects.filter(o=>o!==obj);
    obj.userData.listItem?.classList.remove("selected");
    setHelperVisible(obj,false);
    // Hide parent box helper if object is a child in a group
    if (isChildObjectInGroup(obj) && obj.parent) {
      setParentHelperVisible(obj.parent, false);
    }
    // Hide child bounding boxes if object is a group
    if (obj.userData?.isEditorGroup) {
      showChildBoundingBoxes(obj, false);
    }
    updatePropertiesPanel(selectedObjects[selectedObjects.length-1] || null);
    updateTransformButtonStates();
    return;
  }

  if (!selectedObjects.includes(obj)) selectedObjects.push(obj);
  selectedObject = obj;

  obj.userData.listItem?.classList.add("selected");
  
  // Ensure the object has a box helper
  if (!obj.userData.boxHelper) {
    createBoxHelperFor(obj);
  }
  
  setHelperVisible(obj,true);
  updateBoxHelper(obj, BOX_COLORS.selected);
  
  // If this is a child object in a group, also show the parent group's bounding box
  if (isChildObjectInGroup(obj) && obj.parent) {
    const parentGroup = obj.parent;
    // Create parent box helper if it doesn't exist
    if (!parentGroup.userData.parentBoxHelper) {
      createParentBoxHelperFor(parentGroup);
    }
    setParentHelperVisible(parentGroup, true);
    updateParentBoxHelper(parentGroup, 0x888888); // Gray color for parent
  }
  
  // If this is a parent group, show child bounding boxes in gray
  if (obj.userData?.isEditorGroup) {
    showChildBoundingBoxes(obj, true, 0x888888); // Gray color for children
  }
  
  addBoundingBoxDimensions(obj);
  updateModelProperties(obj);
  updatePropertiesPanel(obj);
  updateTransformButtonStates();
}

function selectFromSidebar(obj, li, e){
  const additive = !!(e && (e.shiftKey||e.ctrlKey||e.metaKey));
  const toggle = !!(e && (e.ctrlKey||e.metaKey));
  selectObject(obj, additive, toggle);
}

function selectFromCanvas(obj, additive){
  selectObject(obj, !!additive, false);
}

// ===== Sidebar (DRY creation) =====
function createSidebarItem(obj, name, isGroup=false, parentList=null){
  const li = document.createElement("li");
  let caret = null;
  const label = document.createElement("span");
  label.textContent = name;

  if (isGroup) {
    caret = document.createElement("span");
    caret.className = "caret";
    caret.title = "Toggle children";
    caret.addEventListener("click", e=>{
      e.stopPropagation();
      setGroupExpanded(li, !(caret.classList.contains("expanded")));
    });
    li.appendChild(caret);
  }

  li.appendChild(label);

  li.onclick = e => selectFromSidebar(obj, li, e);
  li.ondblclick = e => {
    if (e.target === label) makeLabelEditable(label, obj);
    else { selectFromSidebar(obj, li, e); frameCameraOn(obj); }
  };

  obj.userData.listItem = li;
  const targetList = parentList || modelList;
  targetList.appendChild(li);

  if (isGroup) {
    const childList = ensureChildList(li);
    childList.classList.add("children-collapsed");
  }
}


function addGroupToList(group, name, parentList = null){
  const targetList = parentList || modelList;
  createSidebarItem(group, name, true, targetList);
  group.userData.listType = "group";
  const childList = group.userData.listItem.nextSibling;
  
  // Skip the first child (parent object) and only show other children
  const childrenToShow = group.children.slice(1);
  childrenToShow.forEach(child=>{
    if (child.userData?.isEditorGroup) {
      // This is a nested group - add it recursively
      addGroupToList(child, child.name || "Group", childList);
    } else {
      // This is a regular model - add it as a child item
      addModelToList(child, child.name || "Model", childList);
    }
  });
}

function addModelToList(model, name, parentList = null){
  const targetList = parentList || modelList;
  createSidebarItem(model, name, false, targetList);
  model.userData.listType = "model";
}

function rebuildGroupSidebar(group) {
  if (!group || !group.userData?.isEditorGroup) return;
  
  // Remove existing child list items
  const groupLi = group.userData.listItem;
  if (!groupLi) return;
  
  const childList = groupLi.nextSibling;
  if (childList && childList.tagName === "UL") {
    // Clear all child items
    while (childList.firstChild) {
      childList.removeChild(childList.firstChild);
    }
    
    // Skip the first child (parent object) and only show other children
    const childrenToShow = group.children.slice(1);
    childrenToShow.forEach(child => {
      if (child.userData?.isEditorGroup) {
        // This is a nested group - add it recursively
        addGroupToList(child, child.name || "Group", childList);
      } else {
        // This is a regular model - add it as a child item
        addModelToList(child, child.name || "Model", childList);
      }
    });
  }
}

function ensureChildList(li){
  let childList = li.nextSibling;
  if (!(childList && childList.tagName === "UL")) {
    childList = document.createElement("ul");
    childList.style.listStyle = "none";
    childList.style.paddingLeft = "12px";
    childList.style.margin = "4px 0 6px 0";
    li.after(childList);
  }
  return childList;
}

function setGroupExpanded(li, expanded){
  const caret = li.querySelector(".caret");
  const childList = ensureChildList(li);
  if (expanded) {
    caret?.classList.add("expanded");
    childList.classList.remove("children-collapsed");
    childList.style.display = "block";
  } else {
    caret?.classList.remove("expanded");
    childList.classList.add("children-collapsed");
    childList.style.display = "none";
  }
}

// ===== Inline renaming =====
function makeLabelEditable(label, obj){
  const input = document.createElement("input");
  input.type = "text";
  input.value = label.textContent;
  input.style.width = "80%";

  label.replaceWith(input);
  input.focus();

  const finish = () => {
    obj.name = (input.value.trim() || obj.name || "Unnamed");
    const newLabel = document.createElement("span");
    newLabel.textContent = obj.name;
    newLabel.ondblclick = () => makeLabelEditable(newLabel, obj);
    input.replaceWith(newLabel);
    obj.userData.listItem.firstChild = newLabel;
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", e=>{
    if (e.key === "Enter") finish();
    if (e.key === "Escape") { input.value = obj.name; finish(); }
  });
}

function renameSelectedObject(){
  if (selectedObjects.length !== 1) return;
  const li = selectedObjects[0].userData.listItem;
  const label = li?.querySelector("span");
  if (label) makeLabelEditable(label, selectedObjects[0]);
}


// ===== Ruler =====
function createRuler(size, step=1){
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({color:0xaaaaaa});
  for(let i=-size/2;i<=size/2;i+=step){
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(i,0,-size/2),new THREE.Vector3(i,0.1,-size/2)]), mat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(i,0,size/2),new THREE.Vector3(i,0.1,size/2)]), mat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-size/2,0,i),new THREE.Vector3(-size/2,0.1,i)]), mat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(size/2,0,i),new THREE.Vector3(size/2,0.1,i)]), mat));
  }
  return group;
}

function addRulerLabels(group, size, step, font){
  const mat = new THREE.MeshBasicMaterial({color:0xaaaaaa});
  for(let i=-size/2;i<=size/2;i+=step){
    if(i===0) continue;
    const labelX = new THREE.Mesh(new THREE.TextGeometry(`${i}m`,{font,size:LABEL_SIZE,height:0}), mat);
    labelX.position.set(i,0.1,-size/2-LABEL_OFFSET);
    group.add(labelX);

    const labelZ = new THREE.Mesh(new THREE.TextGeometry(`${i}m`,{font,size:LABEL_SIZE,height:0}), mat);
    labelZ.position.set(-size/2-LABEL_OFFSET,0.1,i);
    group.add(labelZ);
  }
}

// ===== Human height guide (5'9" ≈ 1.75m) =====
function createHumanGuide(heightMeters=HUMAN_HEIGHT){
  const group = new THREE.Group();
  const color = 0x66aaff; // subtle bluish
  const opacity = 0.25;
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });

  // Proportions
  const headRadius = Math.min(0.09, heightMeters * 0.062);
  const legHeight = heightMeters * 0.50;
  const torsoHeight = heightMeters * 0.45;
  const shoulderWidth = heightMeters * 0.28;
  const waistWidth = heightMeters * 0.18;
  const limbWidth = Math.max(0.02, heightMeters * 0.06);
  const armLength = torsoHeight * 0.9;

  // Torso
  const torsoTop = new THREE.Mesh(new THREE.PlaneGeometry(shoulderWidth, torsoHeight * 0.55), mat);
  torsoTop.position.y = legHeight + (torsoHeight * 0.75);
  const torsoBottom = new THREE.Mesh(new THREE.PlaneGeometry(waistWidth, torsoHeight * 0.45), mat);
  torsoBottom.position.y = legHeight + (torsoHeight * 0.275);

  // Legs
  const legGeo = new THREE.PlaneGeometry(limbWidth, legHeight);
  const legL = new THREE.Mesh(legGeo, mat);
  legL.position.set(-waistWidth * 0.25, legHeight * 0.5, 0);
  const legR = new THREE.Mesh(legGeo.clone(), mat);
  legR.position.set(waistWidth * 0.25, legHeight * 0.5, 0);

  // Arms
  const armGeo = new THREE.PlaneGeometry(limbWidth, armLength);
  const armL = new THREE.Mesh(armGeo, mat);
  armL.position.set(-shoulderWidth * 0.5, legHeight + torsoHeight - armLength * 0.5, 0);
  const armR = new THREE.Mesh(armGeo.clone(), mat);
  armR.position.set(shoulderWidth * 0.5, legHeight + torsoHeight - armLength * 0.5, 0);

  // Head
  const head = new THREE.Mesh(new THREE.CircleGeometry(headRadius, 24), mat);
  head.position.y = legHeight + torsoHeight + headRadius * 1.05;

  // Crossed for visibility
  const axisGroupA = new THREE.Group();
  axisGroupA.add(torsoTop, torsoBottom, legL, legR, armL, armR, head);
  const axisGroupB = axisGroupA.clone();
  axisGroupB.traverse(node=>{ if (node.isMesh) node.geometry = node.geometry.clone(); });
  axisGroupB.rotation.y = Math.PI / 2;

  group.add(axisGroupA, axisGroupB);

  // Non-interactive
  group.userData.isSelectable = false;
  group.traverse(o=>{ o.userData.isSelectable = false; o.raycast = () => {}; });
  group.name = "HumanGuide";
  return group;
}

// Scale down any model so its height does not exceed HUMAN_HEIGHT
function fitModelToMaxHeight(obj, maxHeightMeters=HUMAN_HEIGHT){
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  if (size.y <= 0) return;
  if (size.y > maxHeightMeters) {
    const k = maxHeightMeters / size.y;
    obj.scale.multiplyScalar(k);
  }
}


// ===== File loading (preserve original pivot & transform) =====
fileInput.addEventListener("change", e=>{
  const file = e.target.files[0]; if(!file) return;
  const url = URL.createObjectURL(file);
  loader.load(url, gltf=>{
    const model = gltf.scene;
    model.userData.isSelectable = true;
    model.name = (file.name || ("Model "+modelCounter++)).replace(/\.[^/.]+$/, "");
    // Track original source for export/reference reuse
    model.userData.sourceRef = {
      originalFileName: file.name,
      baseName: model.name,
      reference: model.name + ".glb"
    };
    createBoxHelperFor(model);

    // Enforce maximum height relative to human guide
    fitModelToMaxHeight(model, HUMAN_HEIGHT);
    scene.add(model);

    addModelToList(model, model.name);
    storeInitialTransform(model);
    selectObject(model);
    updateBoxHelper(model);
    frameCameraOn(model);
    saveState();
  });
});

// ===== Group / Ungroup =====
function groupSelectedObjects(){
  if (selectedObjects.length < 2) return;
  
  // Use the first (top-most) selected object as the parent group
  const parentObj = selectedObjects[0];
  const otherObjects = selectedObjects.slice(1);
  
  // Convert the parent object to a group
  const group = new THREE.Group();
  group.userData.isSelectable = true;
  group.userData.isEditorGroup = true;
  group.name = parentObj.name || "Group " + Date.now();
  
  // Copy parent object's transform to the group
  group.position.copy(parentObj.position);
  group.quaternion.copy(parentObj.quaternion);
  group.scale.copy(parentObj.scale);
  
  // Remove parent object from scene and add it as first child of group
  scene.remove(parentObj);
  group.add(parentObj);
  
  // Reset parent object's transform relative to group
  parentObj.position.set(0, 0, 0);
  parentObj.quaternion.set(0, 0, 0, 1);
  parentObj.scale.set(1, 1, 1);
  
  // Clean up parent object's sidebar representation
  if (parentObj.userData.listItem) {
    const li = parentObj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if(next && next.tagName==="UL") next.remove();
    delete parentObj.userData.listItem;
  }
  
  // Add other objects to the group
  otherObjects.forEach(obj=>{
    // Remember how this object appeared in the sidebar before grouping
    if (!obj.userData) obj.userData = {};
    obj.userData.originalListType = obj.userData.listType || (obj instanceof THREE.Group ? "group" : "model");
    obj.userData.originalName = obj.name;
    if(obj.userData.boxHelper){ scene.remove(obj.userData.boxHelper); delete obj.userData.boxHelper; }
    if(obj.userData.dimGroup){ scene.remove(obj.userData.dimGroup); delete obj.userData.dimGroup; }
    group.attach(obj);
    if (obj.userData.listItem) {
      const li = obj.userData.listItem;
      const next = li.nextSibling;
      li.remove();
      if(next && next.tagName==="UL") next.remove();
      delete obj.userData.listItem;
    }
  });

  scene.add(group);
  createBoxHelperFor(group);
  createParentBoxHelperFor(group);
  addGroupToList(group, group.name);
  storeInitialTransform(group);
  selectObject(group);
  updateAllVisuals(group);
}

function ungroupSelectedObject(){
  if (selectedObjects.length !== 1) return;
  const group = selectedObjects[0];
  if (!(group instanceof THREE.Group)) return;
  if (!group.userData || group.userData.isEditorGroup !== true) return;
  
  // Hide child bounding boxes before ungrouping
  showChildBoundingBoxes(group, false);
  
  while (group.children.length > 0) {
    const child = group.children[0];
    scene.attach(child);
    createBoxHelperFor(child);
    // Hide the child's bounding box after ungrouping
    setHelperVisible(child, false);
    // Restore original sidebar representation and label
    if (child.userData?.originalName) child.name = child.userData.originalName;
    const listType = child.userData?.originalListType || child.userData?.listType || (child instanceof THREE.Group ? "group" : "model");
    if (listType === "group") addGroupToList(child, child.name || "Group");
    else addModelToList(child, child.name || "Model");
    delete child.userData?.originalListType;
    delete child.userData?.originalName;
    updateAllVisuals(child);
  }
  cleanupObject(group);
  scene.remove(group);
  selectedObjects = [];
  selectedObject = null;
  transform.detach();
  updatePropertiesPanel(null);
}

// ===== Delete =====
function deleteObject(obj){
  if(!obj) return;
  if(transform.object===obj) transform.detach();
  if (obj instanceof THREE.Group) {
    const children = [...obj.children];
    children.forEach(child=>{
      cleanupObject(child);
      obj.remove(child);
    });
  }
  cleanupObject(obj);
  if(obj.parent) obj.parent.remove(obj);
  selectedObjects = selectedObjects.filter(o=>o!==obj);
  if(selectedObject===obj) selectedObject=null;
  updatePropertiesPanel(selectedObject||null);
}

// ===== Camera helpers =====
function animateCamera(toPos, toTarget, duration=800){
  const fromPos = camera.position.clone();
  const fromTarget = orbit.target.clone();
  const start = performance.now();
  const ease = t => (t<0.5?2*t*t:-1+(4-2*t)*t);
  function step(now){
    const t = Math.min(1, (now-start)/duration);
    const k = ease(t);
    camera.position.lerpVectors(fromPos, toPos, k);
    orbit.target.lerpVectors(fromTarget, toTarget, k);
    camera.lookAt(orbit.target);
    if (t<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function frameCameraOn(obj){
  const box = getBox(obj);
  const sizeLen = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  const newPos = center.clone().add(new THREE.Vector3(sizeLen,sizeLen,sizeLen));
  animateCamera(newPos, center);
}

function resetCamera(){
  if(selectedObject) frameCameraOn(selectedObject);
  else animateCamera(new THREE.Vector3(groundSize,groundSize,groundSize), new THREE.Vector3(0,0,0));
}

// ===== Canvas size & snap =====
canvasSizeInput.addEventListener("change", e=>{
  groundSize = parseFloat(e.target.value) || 20;
  scene.remove(grid);
  grid = new THREE.GridHelper(groundSize, groundSize, 0x888888, 0x444444);
  grid.userData.isSelectable = false;
  scene.add(grid);
  if (ruler) scene.remove(ruler);
  if (loadedFont) {
    ruler = createRuler(groundSize,1);
    addRulerLabels(ruler,groundSize,1,loadedFont);
    ruler.userData.isSelectable = false;
    scene.add(ruler);
  }
  orbit.maxDistance = groundSize * 1.5;
  selectedObjects.forEach(o=>updateAllVisuals(o));
});

snapCheckbox.addEventListener("change", e=>{
  const enabled = e.target.checked;
  transform.setTranslationSnap(enabled?1:null);
  transform.setRotationSnap(enabled?THREE.MathUtils.degToRad(15):null);
});

// ===== Hover & selection (canvas) =====
renderer.domElement.addEventListener("mousemove", e=>{
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2-1,
    -((e.clientY-rect.top)/rect.height)*2+1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  let obj = null;
  if (hits.length>0){
    obj = hits[0].object;
    while (obj.parent && !obj.userData.isSelectable) obj = obj.parent;
    if (!obj.userData.isSelectable) obj = null;
  }
  if (hoveredObject && !selectedObjects.includes(hoveredObject)) setHelperVisible(hoveredObject,false);
  hoveredObject = obj;
  if (hoveredObject && !selectedObjects.includes(hoveredObject)){
    updateBoxHelper(hoveredObject, BOX_COLORS.hover);
    setHelperVisible(hoveredObject,true);
  }
});

renderer.domElement.addEventListener("click", e=>{
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2-1,
    -((e.clientY-rect.top)/rect.height)*2+1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  if (hits.length>0){
    let obj = hits[0].object;
    while (obj.parent && !obj.userData.isSelectable) obj = obj.parent;
    if (obj.userData.isSelectable){
      selectFromCanvas(obj, e.shiftKey);
      frameCameraOn(obj);
    }
  }
});

// ===== Double-click focus =====
renderer.domElement.addEventListener("dblclick", e=>{
  if (transform.dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2-1,
    -((e.clientY-rect.top)/rect.height)*2+1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  let target = null;
  if (hits.length>0){
    let obj = hits[0].object;
    while (obj.parent && !obj.userData.isSelectable) obj = obj.parent;
    if (obj.userData.isSelectable) target = obj;
  }
  if (target) { selectFromCanvas(target, false); frameCameraOn(target); }
  else resetCamera();
});

// ===== Keyboard shortcuts =====
window.addEventListener("keydown", e=>{
  const key = e.key.toLowerCase();
  const inForm = (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
  const isHotkey = ["w","e","r","q","f","h","z","delete"].includes(key);
  if (inForm && !isHotkey) return;

  switch(key){
    case "w": 
      if (isEditingAllowed()) transform.setMode("translate"); 
      break;
    case "e": 
      if (isEditingAllowed()) transform.setMode("rotate"); 
      break;
    case "r": 
      if (isEditingAllowed()) transform.setMode("scale"); 
      break;
    case "q":
      if(e.shiftKey){ if(selectedObject) transform.attach(selectedObject); }
      else transform.detach();
      break;
    case "f": if(selectedObject) frameCameraOn(selectedObject); break;
    case "h": {
      const helpOverlay = document.getElementById("helpOverlay");
      if(helpOverlay) helpOverlay.style.display = (helpOverlay.style.display==="none"||helpOverlay.style.display==="")?"block":"none";
      break;
    }
    case "delete":
      if(selectedObjects.length) [...selectedObjects].forEach(deleteObject);
      else if (selectedObject) deleteObject(selectedObject);
      break;
    default:
      if ((e.ctrlKey||e.metaKey) && key==="z"){ e.preventDefault(); undo(); }
      break;
  }
});

// ===== Fix #ui buttons =====
btnTranslate.onclick = () => {
  if (isEditingAllowed()) transform.setMode("translate");
};
btnRotate.onclick = () => {
  if (isEditingAllowed()) transform.setMode("rotate");
};
btnScale.onclick = () => {
  if (isEditingAllowed()) transform.setMode("scale");
};
btnDelete.onclick = () => {
  if(selectedObjects.length) [...selectedObjects].forEach(deleteObject);
  else if (selectedObject) deleteObject(selectedObject);
};
btnUndo.onclick = () => undo();
btnResetCamera.onclick = () => resetCamera();

// ===== Resize =====
window.addEventListener("resize", ()=>{
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  selectedObjects.forEach(o=>updateBoxHelper(o));
  if (hoveredObject) updateBoxHelper(hoveredObject);
});

// ===== Transform events =====
transform.addEventListener("dragging-changed", e=>{
  orbit.enabled = !e.value;
  selectedObjects.forEach(o=>{
    updateBoxHelper(o, e.value?BOX_COLORS.editing:BOX_COLORS.selected);
    setHelperVisible(o,true);
  });
  if (!e.value) saveState();
});

transform.addEventListener("objectChange", ()=>{
  if(!selectedObject) return;
  if(transform.getMode()==="scale"){
    const s = selectedObject.scale.x;
    selectedObject.scale.set(s,s,s);
    snapUniformScale(selectedObject, SNAP_STEP);
  }
  clampToCanvas(selectedObject);
  updateAllVisuals(selectedObject);
});

// ===== Undo =====
const undoStack = [];
function saveState(){
  if (selectedObject) {
    undoStack.push({
      uuid: selectedObject.uuid,
      pos: selectedObject.position.clone(),
      rot: selectedObject.quaternion.clone(),
      scale: selectedObject.scale.clone()
    });
  }
}
function undo(){
  if (!selectedObject || !undoStack.length) return;
  
  // Find the most recent state for the currently selected object
  for (let i = undoStack.length - 1; i >= 0; i--){
    if (undoStack[i].uuid === selectedObject.uuid){
      const last = undoStack.splice(i, 1)[0];
      selectedObject.position.copy(last.pos);
      selectedObject.quaternion.copy(last.rot);
      selectedObject.scale.copy(last.scale);
      updateAllVisuals(selectedObject);
      break;
    }
  }
}

// ===== Render loop =====
function animate(){
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
}
animate();

// ===== Context menu =====
const contextMenu = (function(){
  const menu = document.createElement('ul');
  menu.id = 'contextMenu';
  document.body.appendChild(menu);
  return menu;
})();

const contextActions = {
  "Group": () => groupSelectedObjects(),
  "Ungroup": () => ungroupSelectedObject(),
  "Reset Transform": () => selectedObjects.forEach(resetTransform),
  "Drop to Floor": () => selectedObjects.forEach(dropToFloor),
  "Select All": () => selectAllSidebar(),
  "Deselect All": () => deselectAllSidebar()
};

function showContextMenu(x,y,actions){
  contextMenu.innerHTML = "";
  actions.forEach(action=>{
    const li = document.createElement("li");
    li.textContent = action;
    li.style.padding = "4px 12px";
    li.style.cursor = "pointer";
    li.onmouseenter = () => li.style.background = "#444";
    li.onmouseleave = () => li.style.background = "transparent";
    li.onclick = () => { contextMenu.style.display="none"; contextActions[action]?.(); };
    contextMenu.appendChild(li);
  });
  contextMenu.style.left = x+"px";
  contextMenu.style.top = y+"px";
  contextMenu.style.display = "block";
}
document.addEventListener("click", ()=> contextMenu.style.display="none");

// Canvas context menu
renderer.domElement.addEventListener("contextmenu", e=>{
  e.preventDefault();
  let actions = ["Select All","Deselect All"];
  if (selectedObjects.length > 1) actions = ["Group","Reset Transform","Drop to Floor","Select All","Deselect All"];
  else if (selectedObjects.length === 1) {
    const obj = selectedObjects[0];
    actions = ["Reset Transform","Drop to Floor","Select All","Deselect All"];
    if ((obj instanceof THREE.Group) && obj.userData?.isEditorGroup === true) actions.unshift("Ungroup");
  }
  showContextMenu(e.clientX, e.clientY, actions);
});

// Sidebar context menu
modelList.addEventListener("contextmenu", e=>{
  e.preventDefault();
  const li = e.target.closest("li");
  if (!li) return;
  const obj = findObjectByListItem(li);
  if (!obj) return;
  if (!selectedObjects.includes(obj)) selectFromSidebar(obj, li, e);

  let actions = ["Select All","Deselect All"];
  if (selectedObjects.length > 1) actions = ["Group","Reset Transform","Drop to Floor","Select All","Deselect All"];
  else if (selectedObjects.length === 1) {
    actions = ["Reset Transform","Drop to Floor","Select All","Deselect All"];
    if ((obj instanceof THREE.Group) && obj.userData?.isEditorGroup === true) actions.unshift("Ungroup");
  }
  showContextMenu(e.clientX, e.clientY, actions);
});

function findObjectByListItem(li){
  let found = null;
  scene.traverse(obj=>{
    if (obj.userData?.listItem === li) found = obj;
  });
  return found;
}

function selectAllSidebar(){
  deselectAllSidebar();
  const topItems = [...modelList.querySelectorAll(":scope > li")];
  topItems.forEach(li=>{
    const obj = findObjectByListItem(li);
    if (obj?.userData.isSelectable){
      li.classList.add("selected");
      selectedObjects.push(obj);
      setHelperVisible(obj,true);
      updateBoxHelper(obj, BOX_COLORS.selected);
      addBoundingBoxDimensions(obj);
    }
  });
  selectedObject = selectedObjects[selectedObjects.length-1] || null;
  if (selectedObject){
    updateModelProperties(selectedObject);
    updatePropertiesPanel(selectedObject);
  }
  updateTransformButtonStates();
}

function deselectAllSidebar(){
  selectedObjects.forEach(o=>{
    o.userData.listItem?.classList.remove("selected");
    setHelperVisible(o,false);
    // Hide parent box helper if object is a child in a group
    if (isChildObjectInGroup(o) && o.parent) {
      setParentHelperVisible(o.parent, false);
    }
    // Hide child bounding boxes if object is a group
    if (o.userData?.isEditorGroup) {
      showChildBoundingBoxes(o, false);
    }
    if (o.userData.dimGroup) scene.remove(o.userData.dimGroup);
  });
  selectedObjects = [];
  selectedObject = null;
  transform.detach();
  updatePropertiesPanel(null);
  updateTransformButtonStates();
}


// ===== Export JSON (quaternions) =====
document.getElementById("exportJson").onclick = ()=>{
  function buildNode(obj){
    if (!obj.userData?.isSelectable) return null;
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const q = obj.quaternion;
    const rawName = (obj.name && obj.name.length) ? obj.name :
      (obj.userData.listItem ? obj.userData.listItem.textContent : "FILE");
    const baseName = rawName.replace(/\.[^/.]+$/, "");
    const sourceRef = obj.userData?.sourceRef;
    const node = {
      Resource_sName: baseName,
      Resource_sReference: (obj instanceof THREE.Group && obj.userData?.isEditorGroup === true)
        ? (obj.children[0]?.userData?.sourceRef?.reference || (baseName + ".glb"))
        : (sourceRef?.reference || (baseName + ".glb")),
      Transform_Position_dX: obj.position.x,
      Transform_Position_dY: obj.position.y,
      Transform_Position_dZ: obj.position.z,
      Transform_Rotation_dX: q.x,
      Transform_Rotation_dY: q.y,
      Transform_Rotation_dZ: q.z,
      Transform_Rotation_dW: q.w,
      Transform_Scale_dX: obj.scale.x,
      Transform_Scale_dY: obj.scale.y,
      Transform_Scale_dZ: obj.scale.z,
      Bound_dX: size.x,
      Bound_dY: size.y,
      Bound_dZ: size.z
    };
    if (obj instanceof THREE.Group) {
      node.Resource_bIsGroup = true;
      node.Children = [];
      
      // For editor groups, skip the first child (parent object) and only export other children
      const childrenToExport = obj.userData?.isEditorGroup === true 
        ? obj.children.slice(1) 
        : obj.children;
        
      childrenToExport.forEach(child=>{
        const childNode = buildNode(child);
        if (childNode) node.Children.push(childNode);
      });
    } else {
      node.Resource_bIsGroup = false;
    }
    return node;
  }
  const exportData = [];
  scene.children.forEach(obj=>{
    const node = buildNode(obj);
    if (node) exportData.push(node);
  });
  const jsonText = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "index.msf.json"; a.click();
  URL.revokeObjectURL(url);
};
